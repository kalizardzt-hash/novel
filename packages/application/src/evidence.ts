import type { Entity, MemoryFact } from '../../domain/src/index.ts';
import { cardTemplates, fieldVisibility, projectEntity } from '../../domain/src/templates.ts';
/** Task-facing language deliberately excludes database bookkeeping and nested JSON strings. */
export function entityEvidence(entity: Entity, prose: boolean): string {
  const projected = projectEntity(entity, prose);
  return [
    `${cardTemplates[entity.kind].label}：${entity.name}`,
    entity.aliases.length ? `别名：${entity.aliases.join('、')}` : '',
    entity.description ? `描述：${entity.description}` : '',
    ...Object.entries(projected.fields)
      .filter(([, value]) => value)
      .map(
        ([key, value]) =>
          `${key}${fieldVisibility(entity, key) === 'author' ? '（作者资料，不代表他人已知）' : ''}：${value}`,
      ),
    entity.storyTime ? `故事时间：${entity.storyTime}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
export function memoryEvidence(fact: MemoryFact): string {
  return [
    `记录类型：${fact.kind}；主体：${fact.subject}；属性：${fact.predicate}；值：${fact.value}`,
    fact.holder ? `知识/信念持有人：${fact.holder}，不能推定其他人物知道` : '',
    `来源：第${fact.chapterNumber}章，第${fact.chapterRevision}版；故事时间：${fact.storyTime || '未明确'}`,
    `原文证据：${fact.quote}`,
  ]
    .filter(Boolean)
    .join('\n');
}
