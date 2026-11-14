import { createHash } from 'node:crypto';
import {
  KolorAgent,
  type McpServerConfig,
  type ToolDefinition,
} from 'kolorbot-agent-loop';
import { SessionStore } from 'kolorbot-sessions';
import { SkillsRegistry, type SkillRoot } from 'kolorbot-skills';
import type { SchedulerConfig } from './config.js';
import { resolveActiveTarget } from './provider.js';
import type { ModelTarget } from './model-target.js';
import type { SessionTask } from './types.js';
import { formatTaskMessage } from './task-scheduler.js';

export interface ScheduledTurnRunnerOptions {
  config: SchedulerConfig;
  sessions: SessionStore;
  skills: SkillsRegistry;
  logger?: (message: string, error?: unknown) => void;
  now?: () => Date;
}

interface CachedAgent {
  agent: KolorAgent;
  signature: string;
}

/**
 * Runs scheduled tasks headlessly in the scheduler daemon.
 *
 * One agent per session keeps MCP connections alive between firings. Context is
 * loaded from and written back to the shared sessions database; the web process
 * may be down the whole time.
 */
export class ScheduledTurnRunner {
  readonly #options: ScheduledTurnRunnerOptions;
  readonly #agents = new Map<string, CachedAgent>();
  readonly #sessions: SessionStore;

  constructor(options: ScheduledTurnRunnerOptions) {
    this.#options = options;
    this.#sessions = options.sessions;
  }

  async run(task: SessionTask): Promise<void> {
    const session = this.#sessions.require(task.sessionId);
    const target = resolveActiveTarget(this.#options.config.providersPath);
    if (target === undefined) {
      throw new Error('no model is configured for the scheduler daemon');
    }

    const signature = signatureOf(target, this.#options.skills);
    let cached = this.#agents.get(session.id);
    if (cached !== undefined && cached.signature !== signature) {
      await cached.agent.dispose();
      cached = undefined;
    }
    if (cached === undefined) {
      const agent = await KolorAgent.create(
        {
          apiUrl: target.apiUrl,
          apiModelName: target.apiModelName,
          apiKey: target.apiKey,
          agentId: session.id,
          mcpServers: mcpConfigs(this.#options.skills),
        },
        {
          id: session.id,
          context: session.context,
          kolorFrame: {
            root: this.#options.config.workspace,
            skillsRoot: this.#options.config.skillsDir,
            extraSkillRoots: [
              this.#options.config.userSkillsDir,
              this.#options.config.builtinSkillsDir,
            ],
          },
          ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
        },
      );
      cached = { agent, signature };
      this.#agents.set(session.id, cached);
    }

    const message = formatTaskMessage(task.name, this.#options.now?.() ?? new Date());
    await cached.agent.run(message);
    this.#sessions.replaceContext(session.id, cached.agent.exportContext());
  }

  async disposeSession(sessionId: string): Promise<void> {
    const cached = this.#agents.get(sessionId);
    this.#agents.delete(sessionId);
    await cached?.agent.dispose();
  }

  async close(): Promise<void> {
    const cached = [...this.#agents.values()];
    this.#agents.clear();
    await Promise.allSettled(cached.map((entry) => entry.agent.dispose()));
  }
}

/** Tool definitions are not used by the daemon (reminders are created via the web). */
export type { ToolDefinition };

function signatureOf(target: ModelTarget, skills: SkillsRegistry): string {
  return createHash('sha1')
    .update(`${target.apiUrl}\0${target.apiModelName}\0${target.apiKey}\0${JSON.stringify(mcpConfigs(skills))}`)
    .digest('hex');
}

/** Convert skill-declared MCP servers into agent-loop configs. */
export function mcpConfigs(registry: SkillsRegistry): McpServerConfig[] {
  return registry.mcpServers().map((server) => {
    if (server.transport === 'stdio') {
      return {
        name: server.name,
        transport: 'stdio',
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        ...(server.env === undefined ? {} : { env: server.env }),
      };
    }
    return {
      name: server.name,
      transport: server.transport,
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: server.headers }),
    };
  });
}

/** Build the skills registry for the three skill areas. */
export function skillsForConfig(config: SchedulerConfig): SkillsRegistry {
  const roots: SkillRoot[] = [
    { source: 'user', path: config.userSkillsDir },
    { source: 'agents', path: config.skillsDir },
    { source: 'builtin', path: config.builtinSkillsDir },
  ];
  return new SkillsRegistry({ roots });
}
