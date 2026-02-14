import {
  recordScreenAgentRestart,
  recordScreenAgentStartup,
} from '../../store/appSettings';
import type {
  ScreenAgentLifecyclePersistence,
  ScreenAgentLifecyclePersistenceResult,
} from './lifecycle';

function toPersistenceResult(state: {
  startupCount: number;
  restartCount: number;
}): ScreenAgentLifecyclePersistenceResult {
  return {
    startupCount: state.startupCount,
    restartCount: state.restartCount,
  };
}

export function createScreenAgentLifecycleStorePersistence(): ScreenAgentLifecyclePersistence {
  return {
    onStartup: (runId, startedAt) =>
      toPersistenceResult(recordScreenAgentStartup(runId, startedAt)),
    onRestart: (runId, restartToken, restartedAt) =>
      toPersistenceResult(recordScreenAgentRestart(runId, restartToken, restartedAt)),
  };
}
