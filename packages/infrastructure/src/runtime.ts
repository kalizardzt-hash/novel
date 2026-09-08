import path from 'node:path';
import { NovelRunner } from '../../application/src/runner.ts';
import { readConfig, dataDirectory, type AppConfig } from './config.ts';
import { OpenAICompatibleEmbeddings, OpenAICompatibleModel } from './openai.ts';
import { SqliteStoryStore } from './store.ts';
export function openStore() {
  return new SqliteStoryStore(path.join(dataDirectory(), 'novel.sqlite'));
}
export function createRunner(store: SqliteStoryStore, config: AppConfig = readConfig()) {
  return new NovelRunner(
    store,
    new OpenAICompatibleModel(config.model),
    config.embedding.enabled
      ? new OpenAICompatibleEmbeddings({
          baseUrl: config.model.baseUrl,
          apiKey: config.model.apiKey,
          identifier: config.embedding.identifier,
          enabled: config.embedding.enabled,
        })
      : undefined,
    {
      context: {
        cap: config.model.contextCap,
        output: config.model.outputTokens,
        margin: config.model.marginTokens,
        limit: config.retrieval.limit,
        rrfK: config.retrieval.rrfK,
      },
      temperature: config.model.temperature,
      analysisTemperature: config.model.analysisTemperature,
      timeoutMs: config.model.timeoutMs,
      retries: config.worker.retries,
      revisionRounds: config.worker.revisionRounds,
      embeddingChunkChars: config.embedding.chunkChars,
      summaryBatchSize: config.memory.summaryBatchSize,
    },
  );
}
