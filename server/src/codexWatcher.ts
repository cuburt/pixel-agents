import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRecord } from '../../core/src/isRecord.js';
import type {
  Directory,
  DirectoryConversations,
  FoundConversation,
  UsageLimits,
  UsageWindow,
} from '../../core/src/messages.js';
import { createAgentState } from './agentState.js';
import type { AgentStateStore } from './agentStateStore.js';
import { CONVERSATIONS_PER_DIRECTORY } from './constants.js';
import { applyReportedContext } from './contextUsage.js';
import type { ConversationQuery } from './conversations.js';
import { inheritedEnv, terminalEnv } from './terminal/terminalEnv.js';
import type { TerminalSessions } from './terminal/terminalSessions.js';
import type { AgentState } from './types.js';

const QUIET_MS = 90_000;
const WINDOW_BYTES = 256 * 1024;
const TOOL_ID = 'codex-current-tool';
const developerRoot = path.join(os.homedir(), 'Developer');
const workspaceRoot = path.join(developerRoot, 'cogonlabs');

function isUnder(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function includedDirectory(directory: string): string | undefined {
  if (!path.isAbsolute(directory)) return;
  if (!isUnder(workspaceRoot, directory)) {
    // Resolve the recorded paths from before these projects moved into cogonlabs.
    for (const project of ['cogon-core', 'cogonlabs.io']) {
      const oldRoot = path.join(developerRoot, project);
      if (isUnder(oldRoot, directory) && !fs.existsSync(oldRoot)) {
        directory = path.join(workspaceRoot, project, path.relative(oldRoot, directory));
        break;
      }
    }
  }
  if (!isUnder(workspaceRoot, directory)) return;
  try {
    const actual = fs.realpathSync(directory);
    if (isUnder(fs.realpathSync(workspaceRoot), actual) && fs.statSync(actual).isDirectory())
      return path.resolve(directory);
  } catch {
    // The workspace no longer exists.
  }
}

type Activity = 'waiting' | 'active' | 'tool';
interface Session {
  id: string;
  cwd: string;
  size: number;
  mtime: number;
  activity: Activity;
  context?: { usedPercentage: number; windowTokens: number };
  usage?: UsageLimits;
}

function usageWindow(value: unknown, minutes: number): UsageWindow | undefined {
  if (!isRecord(value) || value.window_minutes !== minutes) return;
  const { used_percent, resets_at } = value;
  if (
    typeof used_percent === 'number' &&
    used_percent >= 0 &&
    typeof resets_at === 'number' &&
    resets_at > 0
  ) {
    return { usedPercentage: Math.min(100, used_percent), resetsAt: resets_at };
  }
}

function record(
  line: string,
): { type: unknown; timestamp: unknown; payload: Record<string, unknown> } | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (isRecord(value) && isRecord(value.payload))
      return { type: value.type, timestamp: value.timestamp, payload: value.payload };
  } catch {
    // Codex may be in the middle of appending the record.
  }
}

function readWindow(fd: number, start: number, length: number): string {
  const buffer = Buffer.alloc(length);
  return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, length, start));
}

function readTail(fd: number, session: Session): void {
  const start = Math.max(0, session.size - WINDOW_BYTES);
  const lines = readWindow(fd, start, session.size - start).split('\n');
  if (start > 0) lines.shift();
  let activity: Activity | undefined;
  let context: Session['context'];
  let usage: Session['usage'];
  for (const line of lines.reverse()) {
    const entry = record(line);
    if (!entry) continue;
    const kind = entry.payload.type;
    if (entry.type === 'event_msg') {
      if (kind === 'task_complete' || kind === 'turn_aborted') activity ??= 'waiting';
      if (kind === 'task_started' || kind === 'user_message') activity ??= 'active';
      if (kind === 'agent_message')
        activity ??= entry.payload.phase === 'final_answer' ? 'waiting' : 'active';
      if (kind !== 'token_count') continue;
      const { info, rate_limits: limits } = entry.payload;
      if (isRecord(info) && isRecord(info.last_token_usage)) {
        const windowTokens = info.model_context_window;
        const tokens = info.last_token_usage.input_tokens;
        if (
          typeof windowTokens === 'number' &&
          windowTokens > 0 &&
          typeof tokens === 'number' &&
          tokens >= 0
        )
          context ??= {
            windowTokens,
            usedPercentage: Math.min(100, (tokens / windowTokens) * 100),
          };
      }
      if (isRecord(limits) && limits.limit_id === 'codex' && typeof entry.timestamp === 'string') {
        const fiveHour = usageWindow(limits.primary, 300);
        const sevenDay = usageWindow(limits.secondary, 10080);
        const updatedAt = Date.parse(entry.timestamp);
        if ((fiveHour || sevenDay) && Number.isFinite(updatedAt))
          usage ??= { type: 'usageLimits', providerId: 'codex', fiveHour, sevenDay, updatedAt };
      }
    }
    if (entry.type === 'response_item') {
      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call')
        activity ??= 'tool';
      if (
        kind === 'function_call_output' ||
        kind === 'custom_tool_call_output' ||
        kind === 'reasoning'
      )
        activity ??= 'active';
    }
    if (activity && context && usage) break;
  }
  session.activity = activity ?? session.activity;
  session.context = context ?? session.context;
  session.usage = usage ?? session.usage;
}

function report(store: AgentStateStore, agent: AgentState, activity: Activity): void {
  const waiting = activity === 'waiting';
  if (agent.isWaiting !== waiting || agent.turnActive === undefined) {
    agent.isWaiting = waiting;
    agent.turnActive = !waiting;
    store.broadcast({
      type: 'agentStatus',
      id: agent.id,
      status: waiting ? 'waiting' : 'active',
      awaitingInput: false,
    });
  }
  if (activity === 'tool' && !agent.activeToolIds.has(TOOL_ID)) {
    const status = 'Running a Codex tool';
    agent.activeToolIds.add(TOOL_ID);
    agent.activeToolStatuses.set(TOOL_ID, status);
    store.broadcast({ type: 'agentToolStart', id: agent.id, toolId: TOOL_ID, status });
  } else if (activity !== 'tool' && agent.activeToolIds.delete(TOOL_ID)) {
    agent.activeToolStatuses.delete(TOOL_ID);
    store.broadcast({ type: 'agentToolDone', id: agent.id, toolId: TOOL_ID });
  }
}

function* rollouts(dir: string, depth = 0): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name))
      yield* rollouts(file, depth + 1);
    else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) yield file;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readTitles(file: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        const item: unknown = JSON.parse(line);
        if (
          isRecord(item) &&
          typeof item.id === 'string' &&
          typeof item.thread_name === 'string' &&
          item.thread_name.trim()
        ) {
          titles.set(item.id, item.thread_name);
        }
      } catch {
        // Ignore an incomplete index entry.
      }
    }
  } catch {
    // Older installations may not have a session index.
  }
  return titles;
}

/** Follow Cogon Labs rollouts, with one character and one office-owned terminal. */
export function watchCodexSessions(store: AgentStateStore) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const root = path.join(codexHome, 'sessions');
  const sessions = new Map<string, Session | null>();
  let agent: AgentState | undefined;
  let usage: UsageLimits | undefined;
  let terminalSessionId: string | undefined;
  let approvalAt = 0;

  function clearApproval() {
    if (!agent?.permissionSent) return;
    agent.permissionSent = false;
    store.broadcast({ type: 'agentToolPermissionClear', id: agent.id });
  }

  function scan() {
    const now = Date.now();
    let activity: Activity = 'waiting';
    let contextSession: Session | undefined;
    let newestUsage: UsageLimits | undefined;
    const seen = new Set<string>();
    for (const file of rollouts(root)) {
      seen.add(file);
      try {
        let session = sessions.get(file);
        if (session === null) continue;
        const info = fs.statSync(file);
        if (session?.mtime !== info.mtimeMs || session.size !== info.size) {
          const fd = fs.openSync(file, 'r');
          try {
            if (!session) {
              const header = record(
                readWindow(fd, 0, Math.min(info.size, WINDOW_BYTES)).split('\n', 1)[0],
              );
              if (header?.type !== 'session_meta') continue;
              const { id, cwd, source } = header.payload;
              const directory = typeof cwd === 'string' ? includedDirectory(cwd) : undefined;
              if (
                typeof id !== 'string' ||
                !UUID.test(id) ||
                !directory ||
                (isRecord(source) && source.subagent)
              ) {
                sessions.set(file, null);
                continue;
              }
              session = { id, cwd: directory, size: 0, mtime: 0, activity: 'waiting' };
            }
            session.size = info.size;
            session.mtime = info.mtimeMs;
            readTail(fd, session);
            sessions.set(file, session);
          } finally {
            fs.closeSync(fd);
          }
        }
        const current = now - session.mtime < QUIET_MS ? session.activity : 'waiting';
        if (current === 'tool' || (current === 'active' && activity === 'waiting'))
          activity = current;
        if (session.context && (!contextSession || session.mtime > contextSession.mtime))
          contextSession = session;
        if (session.usage && (session.usage.updatedAt ?? 0) > (newestUsage?.updatedAt ?? 0))
          newestUsage = session.usage;
        if (
          agent?.permissionSent &&
          session.id === terminalSessionId &&
          session.mtime > approvalAt &&
          current !== 'tool'
        )
          clearApproval();
      } catch {
        // A rollout can disappear between directory enumeration and opening it.
      }
    }
    for (const file of sessions.keys()) if (!seen.has(file)) sessions.delete(file);
    if (usage !== newestUsage) {
      usage = newestUsage;
      store.broadcast({ type: 'usageLimits', providerId: 'codex', ...usage });
    }
    if (!fs.existsSync(workspaceRoot)) {
      if (agent) store.delete(agent.id);
      agent = undefined;
      return;
    }
    if (!agent || !store.has(agent.id)) {
      const id = store.nextAgentId.current++;
      agent = createAgentState({
        id,
        sessionId: 'cuburt-cogonlabs',
        projectDir: workspaceRoot,
        jsonlFile: '',
        isExternal: true,
        providerId: 'codex',
        directoryName: 'Cuburt · cogonlabs',
        palette: 0,
        repeat: 0,
      });
      store.set(id, agent);
    }
    report(store, agent, activity);
    if (contextSession?.context)
      applyReportedContext(store, { sessionId: agent.sessionId, ...contextSession.context });
  }

  function directories(): Directory[] {
    if (!includedDirectory(workspaceRoot)) return [];
    const paths = new Set([workspaceRoot]);
    for (const session of sessions.values()) if (session) paths.add(session.cwd);
    return Array.from(paths, (cwd) => ({ path: cwd, name: path.basename(cwd), source: 'host' }));
  }

  function history(): FoundConversation[] {
    const titles = readTitles(path.join(codexHome, 'session_index.jsonl'));
    const newest = Array.from(sessions.values())
      .filter((session) => session !== null)
      .sort((a, b) => b.mtime - a.mtime);
    const found = new Map<string, FoundConversation>();
    for (const session of newest) {
      if (found.has(session.id)) continue;
      found.set(session.id, {
        directoryPath: session.cwd,
        directoryName: path.basename(session.cwd),
        conversation: {
          sessionId: session.id,
          title: titles.get(session.id) ?? 'Codex session',
          updatedAt: session.mtime,
          palette: agent?.palette,
          repeat: agent?.repeat,
          ...(session.id === terminalSessionId ? { agentId: agent?.id } : {}),
        },
      });
    }
    return [...found.values()];
  }

  function list(limits: ReadonlyMap<string, number>): DirectoryConversations[] {
    const entries = history();
    return directories().map(({ path, name }) => {
      const limit = limits.get(path) ?? CONVERSATIONS_PER_DIRECTORY;
      const matches = entries.filter((entry) => entry.directoryPath === path);
      return {
        path,
        name,
        conversations: matches.slice(0, limit).map((entry) => entry.conversation),
        more: matches.length > limit,
      };
    });
  }

  function search(query: ConversationQuery) {
    const words = query.query.toLowerCase().trim().split(/\s+/);
    const matches = history().filter(
      (entry) =>
        (!query.directoryPath || entry.directoryPath === query.directoryPath) &&
        words.every((word) => entry.conversation.title.toLowerCase().includes(word)),
    );
    return { results: matches.slice(0, query.limit), more: matches.length > query.limit };
  }

  function launch(ptyManager: TerminalSessions, directory: unknown, resumeId?: unknown) {
    if (!agent || !ptyManager.isAvailable() || ptyManager.has(agent.id)) return;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return;
    const cwd = includedDirectory(directory);
    if (!cwd || cwd !== path.resolve(directory)) return;
    if (
      resumeId !== undefined &&
      ![...sessions.values()].some(
        (session) =>
          session?.id === resumeId &&
          session?.cwd === cwd &&
          (session.activity === 'waiting' || Date.now() - session.mtime >= QUIET_MS),
      )
    )
      return;

    const options = [
      '-c',
      'tui.notifications=["approval-requested"]',
      '-c',
      'tui.notification_method="osc9"',
      '-c',
      'tui.notification_condition="always"',
    ];
    const id = agent.id;
    try {
      const terminal = ptyManager.create({
        agentId: id,
        command: 'codex',
        args: typeof resumeId === 'string' ? ['resume', ...options, resumeId] : options,
        cwd,
        env: terminalEnv(
          inheritedEnv({
            isInheritedSessionEnv: (key) =>
              key === 'CODEX_THREAD_ID' ||
              key === 'CODEX_SANDBOX' ||
              key === 'CODEX_SANDBOX_NETWORK_DISABLED',
          }),
        ),
      });
      terminalSessionId = typeof resumeId === 'string' ? resumeId : undefined;
      // Codex sends approval-only OSC 9 notifications in this terminal. Keep a
      // bounded suffix for escape sequences split across terminal chunks.
      let tail = '';
      terminal.onData((chunk) => {
        const output = tail + chunk;
        const alerts = /\x1b\]9;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
        let end = 0;
        for (const match of output.matchAll(alerts)) end = match.index + match[0].length;
        tail = output.slice(end).slice(-8192);
        if (end && agent?.id === id && !agent.permissionSent) {
          approvalAt = Date.now();
          agent.permissionSent = true;
          store.broadcast({ type: 'agentToolPermission', id });
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearApproval();
        terminalSessionId = undefined;
        store.broadcast({ type: 'terminalSessionClosed', agentId: id, exitCode });
      });
      store.broadcast({ type: 'terminalSessionOpened', agentId: id });
    } catch (error) {
      console.error('[Pixel Agents] Could not open the Codex terminal:', error);
    }
  }

  scan();
  const timer = setInterval(scan, 2000);
  return {
    stop: () => clearInterval(timer),
    directories,
    list,
    search,
    launch,
    usage: () => usage,
    owns: (id: number) => agent?.id === id,
  };
}

export type CodexOffice = ReturnType<typeof watchCodexSessions>;
