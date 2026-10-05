# arc-approver

Touch ID approvals for the arc CLI's Agent Controls. When an agent asks to do
something your policy says needs approval, you can approve it on this Mac with
Touch ID instead of on your phone, up to the policy's `macApprovalMaxRisk`
(default `write`, so destructive operations always go to the phone).

## How it works

- `create` makes a P-256 key inside the Secure Enclave with CryptoKit, gated by
  `[.privateKeyUsage, .biometryCurrentSet]`, `WhenUnlockedThisDeviceOnly`.
  The private key never leaves the enclave. `~/.arc-cli/approver.se` (0600) holds
  the enclave-wrapped blob, which only this Mac's enclave can use.
- `sign` reads the message on stdin, shows a Touch ID prompt naming the action
  (`--reason`), and prints an ECDSA P-256 / SHA-256 signature, DER, base64url.
- Adding or removing a fingerprint invalidates the key (`.biometryCurrentSet`);
  the Mac then has to be enrolled again.
- No keychain entries and therefore no entitlements: an ad-hoc signed binary
  works. This is the approach of
  [age-plugin-se](https://github.com/remko/age-plugin-se).

Message formats and the server endpoints are in
`docs/agent-controls/2026-10-05-agent-controls.md` (§4.4, §4.6, §4.7, §6). The CLI
side is `src/agent-controls/mac-approver.ts`.

## Commands

| command | stdout | |
|---|---|---|
| `available` | `{"secureEnclave":true,"biometry":"touchID"}` | never prompts |
| `create [--force]` | public key, raw 65-byte X9.63 point, base64url | refuses to replace a key without `--force` |
| `pubkey` | same | |
| `sign --reason <text>` | DER signature, base64url | message on stdin; prompts for Touch ID |
| `delete` | | removes the key file |
| `version` | helper protocol version | |

The key lives in `$ARC_CONFIG_DIR` (default `~/.arc-cli`).

Exit codes: `0` ok, `1` other, `2` usage, `3` no key, `4` cancelled,
`5` unavailable (no enclave, no Touch ID, lockout, lid closed), `6` key
invalidated. Errors are one JSON line on stderr: `{"error":"<code>","message":"…"}`.

The reason is visible in the prompt and in `ps`. Callers pass only the enum
summary (`approve: Claude Code wants to delete transaction`), never amounts,
payees or notes.

## Building

```sh
native/arc-approver/build.sh [output]   # default native/arc-approver/build/arc-approver
```

Builds arm64 and x86_64 with `swiftc -O` (macOS 13+), joins them with `lipo`,
ad-hoc signs with `codesign -s -`, and prints the sha256. The installer
(`public/install.sh`, block `arc-approver helper`) downloads a pinned release
binary when `ARC_APPROVER_URL`/`ARC_APPROVER_SHA256` are set, otherwise builds
from this directory when `swiftc` exists, otherwise skips: without the helper,
approvals simply go to the phone.
