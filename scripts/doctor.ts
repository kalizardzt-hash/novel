import { OpenAICompatibleModel, OpenAICompatibleEmbeddings } from '../packages/infrastructure/src/openai.ts';
import { readConfig, dataDirectory } from '../packages/infrastructure/src/config.ts';
import { openStore } from '../packages/infrastructure/src/runtime.ts';
const config = readConfig();
const store = openStore();
console.log(
  JSON.stringify(
    {
      dataDirectory: dataDirectory(),
      projects: store.listProjects().length,
      model: await new OpenAICompatibleModel(config.model).info().catch((e) => ({ error: e.message })),
      embedding: await new OpenAICompatibleEmbeddings({
        baseUrl: config.model.baseUrl,
        apiKey: config.model.apiKey,
        identifier: config.embedding.identifier,
        enabled: config.embedding.enabled,
      })
        .identity()
        .catch((e) => ({ error: e.message })),
    },
    null,
    2,
  ),
);
store.close();
