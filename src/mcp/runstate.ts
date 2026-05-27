// Run-state manager — durable progress for an agent-driven workflow run.
//
// The agent calls run_begin at the start, run_note per meaningful step, and
// run_end at the close. Each change is persisted to the agent_runs table, so a
// run survives a daemon restart and the agent can ask "where were we?" via
// run_status. The in-memory `currentId` is a convenience; after a restart,
// run_status with no id falls back to the most recently updated run in the DB.
import { randomUUID } from 'node:crypto';
import { db } from '../shared/db/store.js';
import type { AgentRun, AgentRunStatus } from '../shared/db/types.js';

class RunStateManager {
  private currentId: string | null = null;

  begin(opts: { workflow?: string; goal?: string; vars?: Record<string, unknown> }): AgentRun {
    const now = new Date().toISOString();
    const run: AgentRun = {
      runId: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      workflow: opts.workflow ?? null,
      goal: opts.goal ?? null,
      vars: opts.vars ?? {},
      currentStep: null,
      status: 'running',
      steps: [{ ts: now, note: `run started${opts.goal ? `: ${opts.goal}` : ''}` }],
      startedAt: now,
      updatedAt: now,
    };
    db.saveAgentRun(run);
    this.currentId = run.runId;
    return run;
  }

  private resolve(runId?: string): AgentRun {
    const id = runId ?? this.currentId;
    if (!id) throw new Error('no active run — call run_begin first');
    const run = db.getAgentRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    this.currentId = id;
    return run;
  }

  note(opts: { note: string; currentStep?: string; status?: AgentRunStatus; runId?: string }): AgentRun {
    const run = this.resolve(opts.runId);
    run.steps.push({ ts: new Date().toISOString(), note: opts.note });
    if (opts.currentStep !== undefined) run.currentStep = opts.currentStep;
    if (opts.status) run.status = opts.status;
    db.saveAgentRun(run);
    return run;
  }

  /** The named run, else the in-memory current run, else the latest persisted run. */
  status(runId?: string): AgentRun | null {
    if (runId) return db.getAgentRun(runId);
    if (this.currentId) {
      const r = db.getAgentRun(this.currentId);
      if (r) return r;
    }
    return db.latestAgentRun();
  }

  end(opts: { status?: AgentRunStatus; note?: string; runId?: string }): AgentRun {
    const run = this.resolve(opts.runId);
    if (opts.note) run.steps.push({ ts: new Date().toISOString(), note: opts.note });
    run.status = opts.status ?? 'done';
    db.saveAgentRun(run);
    if (this.currentId === run.runId) this.currentId = null;
    return run;
  }
}

export const runs = new RunStateManager();
