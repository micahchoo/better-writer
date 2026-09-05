import type { Coach, CoachInput, CoachResult } from '../src/core/types.js';
import { runSweep, type SweepResult, type SweepWindowPlan } from './coach-sweep.js';

export type CoachingState = 'idle' | 'asking' | 'sweeping' | 'stopping';
type SweepOptions = Omit<Parameters<typeof runSweep>[1], 'coach' | 'signal' | 'shouldAbort'>;

/** Owns request lifetimes. Draft identity and persistence belong to the caller. */
export class CoachingSession {
  private generation = 0;
  private controller?: AbortController;
  private disposed = false;
  private currentState: CoachingState = 'idle';

  constructor(private coach: Coach, private callbacks: { onState?(state: CoachingState): void } = {}) {}

  get state(): CoachingState { return this.currentState; }

  private setState(state: CoachingState): void {
    this.currentState = state;
    if (!this.disposed) this.callbacks.onState?.(state);
  }

  configure(coach: Coach): void {
    this.cancel();
    this.coach = coach;
  }

  cancel(): void {
    ++this.generation;
    const controller = this.controller;
    this.controller = undefined;
    if (controller) {
      this.setState('stopping');
      controller.abort();
    }
    this.setState('idle');
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  ask(input: CoachInput): Promise<CoachResult | undefined> {
    if (this.disposed || this.state !== 'idle') return Promise.resolve(undefined);
    return this.run('asking', (coach, signal) => coach.ask(input, signal));
  }

  sweep(plan: SweepWindowPlan[], options: SweepOptions): Promise<SweepResult | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    this.cancel();
    return this.run('sweeping', (coach, signal, isCurrent) => runSweep(plan, {
      ...options, coach, signal,
      onNote: (note) => { if (isCurrent()) options.onNote(note); },
      onProgress: (done, total) => { if (isCurrent()) options.onProgress?.(done, total); },
    }));
  }

  private async run<T>(
    state: 'asking' | 'sweeping',
    operation: (coach: Coach, signal: AbortSignal, isCurrent: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    const generation = ++this.generation;
    const coach = this.coach;
    const controller = new AbortController();
    this.controller = controller;
    const isCurrent = () => !this.disposed && generation === this.generation && !controller.signal.aborted;
    let removeAbort = () => {};
    const canceled = new Promise<undefined>((resolve) => {
      const listener = () => resolve(undefined);
      controller.signal.addEventListener('abort', listener, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', listener);
    });
    this.setState(state);
    try {
      if (!isCurrent()) return undefined;
      const result = await Promise.race([operation(coach, controller.signal, isCurrent), canceled]);
      return isCurrent() ? result : undefined;
    } catch (error) {
      if (isCurrent()) throw error;
      return undefined;
    } finally {
      removeAbort();
      if (isCurrent()) {
        this.controller = undefined;
        this.setState('idle');
      }
    }
  }
}
