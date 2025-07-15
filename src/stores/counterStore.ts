import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Counter {
  id: string;
  name: string;
  prefix: string;
  nowServing: number;
  lastIssued: number;
  active: boolean;
}

interface CounterState {
  counters: Counter[];
  hasSetup: boolean;
  setupCounters: (counterConfigs: { id: string; name: string; prefix: string }[]) => void;
  callNext: (counterId: string) => void;
  skipNumber: (counterId: string) => void;
  resetCounter: (counterId: string) => void;
  updatePrefix: (counterId: string, prefix: string) => void;
  removeCounter: (counterId: string) => void;
}

export const useCounterStore = create<CounterState>()(
  persist(
    (set, get) => ({
      counters: [],
      hasSetup: false,
      setupCounters: (counterConfigs) => {
        const counters: Counter[] = counterConfigs.map(config => ({
          id: config.id,
          name: config.name,
          prefix: config.prefix,
          nowServing: 1,
          lastIssued: 1,
          active: true,
        }));
        set({ counters, hasSetup: true });
      },
      callNext: (counterId) => {
        const { counters } = get();
        const updatedCounters = counters.map(counter => {
          if (counter.id === counterId) {
            return {
              ...counter,
              lastIssued: counter.lastIssued + 1,
            };
          }
          return counter;
        });
        set({ counters: updatedCounters });
      },
      skipNumber: (counterId) => {
        const { counters } = get();
        const updatedCounters = counters.map(counter => {
          if (counter.id === counterId) {
            return {
              ...counter,
              nowServing: Math.min(counter.nowServing + 1, counter.lastIssued),
            };
          }
          return counter;
        });
        set({ counters: updatedCounters });
      },
      resetCounter: (counterId) => {
        const { counters } = get();
        const updatedCounters = counters.map(counter => {
          if (counter.id === counterId) {
            return {
              ...counter,
              nowServing: 1,
              lastIssued: 1,
            };
          }
          return counter;
        });
        set({ counters: updatedCounters });
      },
      updatePrefix: (counterId, prefix) => {
        const { counters } = get();
        const updatedCounters = counters.map(counter => {
          if (counter.id === counterId) {
            return { ...counter, prefix };
          }
          return counter;
        });
        set({ counters: updatedCounters });
      },
      removeCounter: (counterId) => {
        const { counters } = get();
        const updatedCounters = counters.filter(counter => counter.id !== counterId);
        set({ counters: updatedCounters, hasSetup: updatedCounters.length > 0 });
      },
    }),
    {
      name: 'queue-joy-counters',
    }
  )
);