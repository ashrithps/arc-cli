// arc-approver — Touch ID approvals for the arc CLI (Agent Controls).
//
// A Secure Enclave P-256 key that only signs after a fresh Touch ID match on
// the currently enrolled fingers. The private key never leaves the enclave:
// `approver.se` holds the enclave-wrapped blob CryptoKit hands back, which is
// useless on any other Mac. Using CryptoKit's SecureEnclave keys (instead of a
// keychain item) means an ad-hoc signed binary needs no entitlements, the same
// approach as age-plugin-se.
//
// Contract: docs/agent-controls/2026-10-05-agent-controls.md §4.4, §4.6, §4.7.
//
//   arc-approver available               {"secureEnclave":bool,"biometry":"touchID"|"none"}
//   arc-approver create [--force]        public key, raw 65-byte X9.63 point, base64url
//   arc-approver pubkey                  same, for the existing key
//   arc-approver sign --reason <text>    message on stdin -> DER signature, base64url
//   arc-approver delete
//   arc-approver version
//
// Exit codes: 0 ok, 1 other, 2 usage, 3 no key, 4 user cancelled,
// 5 unavailable, 6 key invalidated (biometry changed). Errors are one JSON
// line on stderr: {"error":"<code>","message":"..."}. Nothing secret is ever
// printed: the blob is not secret off this Mac, but it is still never echoed.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

let helperVersion = "1"

enum Failure: Error {
  case usage(String)
  case noKey
  case cancelled(String)
  case unavailable(String)
  case invalidated(String)
  case other(String)

  var exitCode: Int32 {
    switch self {
    case .usage: return 2
    case .noKey: return 3
    case .cancelled: return 4
    case .unavailable: return 5
    case .invalidated: return 6
    case .other: return 1
    }
  }

  var code: String {
    switch self {
    case .usage: return "usage"
    case .noKey: return "no_key"
    case .cancelled: return "cancelled"
    case .unavailable: return "unavailable"
    case .invalidated: return "invalidated"
    case .other: return "failed"
    }
  }

  var message: String {
    switch self {
    case .usage(let m), .cancelled(let m), .unavailable(let m), .invalidated(let m), .other(let m):
      return m
    case .noKey:
      return "no approver key on this Mac; enroll it as an approver first"
    }
  }
}

// MARK: - Paths

let configDir: URL = {
  if let dir = ProcessInfo.processInfo.environment["ARC_CONFIG_DIR"], !dir.isEmpty {
    return URL(fileURLWithPath: dir, isDirectory: true)
  }
  return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".arc-cli", isDirectory: true)
}()
let keyURL = configDir.appendingPathComponent("approver.se")
// Opaque hash of the enrolled-fingers set at create time. Lets `sign` report a
// re-enrolled finger as "invalidated" before showing a prompt that cannot work.
let stateURL = configDir.appendingPathComponent("approver.se.state")

func writePrivate(_ data: Data, to url: URL) throws {
  try FileManager.default.createDirectory(
    at: configDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  let tmp = url.appendingPathExtension("tmp-\(getpid())")
  guard FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
    throw Failure.other("could not write \(url.path)")
  }
  if rename(tmp.path, url.path) != 0 {
    try? FileManager.default.removeItem(at: tmp)
    throw Failure.other("could not write \(url.path)")
  }
}

// MARK: - Encoding

func b64url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

func emit(_ line: String) {
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func jsonLine(_ object: [String: Any]) -> String {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  return String(data: data, encoding: .utf8)!
}

// MARK: - Biometry

func biometryState() -> (available: Bool, kind: String, domainState: Data?, error: Error?) {
  let ctx = LAContext()
  var error: NSError?
  let ok = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
  let kind = ctx.biometryType == .touchID ? "touchID" : "none"
  var state: Data? = nil
  if ok {
    if #available(macOS 15.0, *) {
      state = ctx.domainState.biometry.stateHash
    } else {
      state = ctx.evaluatedPolicyDomainState
    }
  }
  return (ok, kind, state, error)
}

func mapLAError(_ error: Error) -> Failure {
  let ns = error as NSError
  if ns.domain == LAError.errorDomain, let code = LAError.Code(rawValue: ns.code) {
    switch code {
    case .userCancel, .appCancel, .systemCancel, .userFallback:
      return .cancelled("approval cancelled")
    case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet:
      return .unavailable("Touch ID is not available: \(ns.localizedDescription)")
    case .authenticationFailed:
      return .cancelled("Touch ID did not match")
    default:
      break
    }
  }
  return .other(ns.localizedDescription)
}

func requireEnclave() throws {
  guard SecureEnclave.isAvailable else { throw Failure.unavailable("this Mac has no Secure Enclave") }
  let bio = biometryState()
  guard bio.available else {
    if let error = bio.error { throw mapLAError(error) }
    throw Failure.unavailable("Touch ID is not available")
  }
}

// MARK: - Key

func loadKey(context: LAContext? = nil) throws -> SecureEnclave.P256.Signing.PrivateKey {
  guard let blob = try? Data(contentsOf: keyURL) else { throw Failure.noKey }
  do {
    return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
  } catch {
    throw Failure.invalidated("the approver key can no longer be opened; enroll this Mac again")
  }
}

func create(force: Bool) throws {
  try requireEnclave()
  if FileManager.default.fileExists(atPath: keyURL.path) && !force {
    throw Failure.usage("an approver key already exists; pass --force to replace it")
  }
  guard let access = SecAccessControlCreateWithFlags(
    nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], nil)
  else { throw Failure.other("could not build the access control") }
  let key: SecureEnclave.P256.Signing.PrivateKey
  do {
    key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: LAContext())
  } catch {
    throw mapLAError(error)
  }
  try writePrivate(key.dataRepresentation, to: keyURL)
  if let state = biometryState().domainState {
    try writePrivate(state, to: stateURL)
  } else {
    try? FileManager.default.removeItem(at: stateURL)
  }
  emit(b64url(key.publicKey.x963Representation))
}

func sign(reason: String) throws {
  let message = FileHandle.standardInput.readDataToEndOfFile()
  guard !message.isEmpty else { throw Failure.usage("sign reads the message from stdin; got nothing") }
  guard FileManager.default.fileExists(atPath: keyURL.path) else { throw Failure.noKey }
  try requireEnclave()
  if let saved = try? Data(contentsOf: stateURL), let current = biometryState().domainState, saved != current {
    throw Failure.invalidated("Touch ID fingers changed since this Mac was enrolled; enroll it again")
  }
  let ctx = LAContext()
  ctx.localizedReason = reason
  let key = try loadKey(context: ctx)
  do {
    let signature = try key.signature(for: message)
    emit(b64url(signature.derRepresentation))
  } catch {
    let failure = mapLAError(error)
    if case .other = failure {
      // The enclave refuses a key whose biometry set changed with a non-LA error.
      throw Failure.invalidated("the approver key was invalidated: \((error as NSError).localizedDescription)")
    }
    throw failure
  }
}

// MARK: - Main

func run(_ args: [String]) throws {
  guard let command = args.first else { throw Failure.usage("usage: arc-approver available|create|pubkey|sign|delete|version") }
  let rest = Array(args.dropFirst())
  switch command {
  case "available":
    let bio = biometryState()
    emit(jsonLine(["secureEnclave": SecureEnclave.isAvailable, "biometry": bio.available ? bio.kind : "none"]))
  case "create":
    guard rest.allSatisfy({ $0 == "--force" }) else { throw Failure.usage("usage: arc-approver create [--force]") }
    try create(force: rest.contains("--force"))
  case "pubkey":
    emit(b64url(try loadKey().publicKey.x963Representation))
  case "sign":
    guard rest.count == 2, rest[0] == "--reason", !rest[1].isEmpty, rest[1].count <= 200 else {
      throw Failure.usage("usage: arc-approver sign --reason <text, at most 200 characters> < message")
    }
    try sign(reason: rest[1])
  case "delete":
    try? FileManager.default.removeItem(at: keyURL)
    try? FileManager.default.removeItem(at: stateURL)
  case "version":
    emit(helperVersion)
  default:
    throw Failure.usage("unknown command: \(command)")
  }
}

do {
  try run(Array(CommandLine.arguments.dropFirst()))
  exit(0)
} catch let failure as Failure {
  FileHandle.standardError.write((jsonLine(["error": failure.code, "message": failure.message]) + "\n").data(using: .utf8)!)
  exit(failure.exitCode)
} catch {
  FileHandle.standardError.write((jsonLine(["error": "failed", "message": "\(error)"]) + "\n").data(using: .utf8)!)
  exit(1)
}
