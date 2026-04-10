import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { ActualClient } from '../client.js';
import { getBudgetPassword, persistBudgetCatalog } from '../credential-store.js';
import * as accountOps from '../operations/accounts.js';
import * as transactionOps from '../operations/transactions.js';

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function withClient<T>(
  options: { budget?: string; password?: string; interactive?: boolean } = {},
  fn: (client: ActualClient) => Promise<T>
): Promise<T> {
  const client = ActualClient.fromEnv();

  if (options.budget) {
    client.selectBudget(options.budget);
    if (options.password) {
      client.setEncryptionPassword(options.password);
    }
  }

  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.disconnect();
    } catch {
      try {
        await client.api.shutdown();
      } catch {
        // Best effort cleanup for MCP calls.
      }
    }
  }
}

async function listBudgetCatalog() {
  const client = ActualClient.fromEnv();

  try {
    await client.init();
    const files = await client.listBudgets();
    persistBudgetCatalog(files);

    return files.map(file => ({
      syncId: file.groupId,
      cloudFileId: file.cloudFileId,
      name: file.name,
      isEncrypted: !!file.encryptKeyId,
      hasSavedPassword: !!getBudgetPassword(file.groupId),
    }));
  } finally {
    try {
      await client.api.shutdown();
    } catch {
      // No-op.
    }
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'arc',
    version: '1.0.0',
  });

  server.registerTool(
    'arc_budgets_list',
    {
      description: 'List budgets available on the configured Actual server.',
    },
    async () => {
      const budgets = await listBudgetCatalog();
      return {
        content: [{ type: 'text', text: jsonText(budgets) }],
      };
    }
  );

  server.registerTool(
    'arc_budget_switch',
    {
      description: 'Switch the default Arc budget context.',
      inputSchema: {
        budget: z.string().min(1).describe('Budget sync id, cloud file id, or name'),
        password: z.string().optional().describe('Encryption password for the target budget'),
      },
    },
    async ({ budget, password }) => {
      const client = ActualClient.fromEnv();

      try {
        const context = await client.switchBudget({
          budgetRef: budget,
          password,
          isInteractive: false,
        });

        return {
          content: [{
            type: 'text',
            text: jsonText({
              syncId: context.groupId,
              cloudFileId: context.cloudFileId,
              name: context.name,
            }),
          }],
        };
      } finally {
        try {
          await client.disconnect();
        } catch {
          try {
            await client.api.shutdown();
          } catch {
            // No-op.
          }
        }
      }
    }
  );

  server.registerTool(
    'arc_accounts_list',
    {
      description: 'List accounts in the active budget or a specified budget.',
      inputSchema: {
        budget: z.string().optional().describe('Optional budget sync id, cloud file id, or name'),
      },
    },
    async ({ budget }) => {
      const accounts = await withClient({ budget }, client => accountOps.listAccounts(client));
      return {
        content: [{ type: 'text', text: jsonText(accounts) }],
      };
    }
  );

  server.registerTool(
    'arc_transactions_list',
    {
      description: 'List transactions for an account in the active budget or a specified budget.',
      inputSchema: {
        accountId: z.string().min(1).describe('Actual account id'),
        budget: z.string().optional().describe('Optional budget sync id, cloud file id, or name'),
        startDate: z.string().optional().describe('Optional YYYY-MM-DD start date'),
        endDate: z.string().optional().describe('Optional YYYY-MM-DD end date'),
      },
    },
    async ({ accountId, budget, startDate, endDate }) => {
      const transactions = await withClient(
        { budget },
        client => transactionOps.listTransactions(client, accountId, startDate, endDate)
      );
      return {
        content: [{ type: 'text', text: jsonText(transactions) }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
