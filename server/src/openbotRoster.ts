import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { isRecord } from '../../core/src/isRecord.js';
import { createAgentState } from './agentState.js';
import type { AgentStateStore } from './agentStateStore.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';

const workspaceRoot = path.join(homedir(), 'OpenBot', 'Agents');
const database = path.join(homedir(), 'Library', 'Application Support', 'OpenBot', 'openbot.db');
const rosterQuery = `
  SELECT a.agent_id AS id, json_extract(a.agent_json, '$.name') AS name,
    EXISTS (
      SELECT 1 FROM projection_threads AS t
      JOIN projection_turns AS p ON p.turn_id = t.active_turn_id
      WHERE t.agent_id = a.agent_id AND p.status = 'running' AND p.completed_at IS NULL
    ) AS working
  FROM projection_agents AS a
  ORDER BY a.sort_order
`;

export function isOpenBotWorkspace(directory: string): boolean {
  const relative = path.relative(workspaceRoot, directory);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}

/** Mirror only OpenBot's agent names and running/idle status. */
export function watchOpenBotRoster(store: AgentStateStore): () => void {
  const ids = new Map<string, number>();
  let warned = false;
  const refresh = () => {
    let rows: unknown;
    try {
      const result = execFileSync(
        '/usr/bin/sqlite3',
        ['-readonly', '-json', database, rosterQuery],
        {
          encoding: 'utf8',
          timeout: 1000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      rows = result.trim() ? JSON.parse(result) : [];
      if (!Array.isArray(rows)) return;
      warned = false;
    } catch {
      // Keep the previous roster if the application is busy or unavailable.
      if (!warned) console.warn('[Pixel Agents] Could not read the local OpenBot roster.');
      warned = true;
      return;
    }
    const seen = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'string' || typeof row.name !== 'string') continue;
      seen.add(row.id);
      const label = `OpenBot · ${row.name}`;
      const existing = ids.get(row.id);
      let agent = existing === undefined ? undefined : store.get(existing);
      if (agent && agent.directoryName !== label) {
        store.delete(agent.id);
        agent = undefined;
      }
      if (!agent) {
        const id = store.nextAgentId.current++;
        agent = createAgentState({
          id,
          sessionId: row.id,
          providerId: 'openbot',
          isExternal: true,
          projectDir: '',
          jsonlFile: '',
          directoryName: label,
        });
        assignPaletteIfNeeded(agent, store, { reservePalette: 0 });
        store.set(id, agent);
        ids.set(row.id, id);
      }
      const working = row.working === 1;
      if (agent.turnActive !== working) {
        agent.turnActive = working;
        agent.isWaiting = !working;
        store.broadcast({
          type: 'agentStatus',
          id: agent.id,
          status: working ? 'active' : 'waiting',
          awaitingInput: false,
        });
      }
    }
    for (const [key, id] of ids) {
      if (!seen.has(key)) {
        store.delete(id);
        ids.delete(key);
      }
    }
  };
  refresh();
  const timer = setInterval(refresh, 2000);
  return () => clearInterval(timer);
}
