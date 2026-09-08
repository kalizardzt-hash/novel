import type { EntityKind, Entity } from './index.ts';
export const cardTemplates: Record<EntityKind, { label: string; fields: string[] }> = {
  character: {
    label: '人物',
    fields: [
      '身份与角色',
      '外貌与习惯',
      '经历',
      '欲望',
      '内在需要',
      '恐惧与弱点',
      '能力及来源',
      '秘密',
      '道德底线',
      '说话方式',
      '人物弧',
    ],
  },
  world: {
    label: '世界观',
    fields: ['时代背景', '历史', '地理', '制度与阶层', '经济与资源', '文化与日常', '核心冲突'],
  },
  location: { label: '地点', fields: ['地理位置', '环境与气候', '交通与距离', '控制者', '进入条件'] },
  faction: { label: '势力', fields: ['目标', '资源来源', '权力结构', '内部矛盾', '日常运作', '对外关系'] },
  item: { label: '物品', fields: ['用途', '所有者', '保管人', '数量', '限制与损耗', '转移记录'] },
  rule: { label: '世界规则', fields: ['触发条件', '效果', '硬限制', '即时代价', '累积代价', '例外及伏笔'] },
  relationship: { label: '关系', fields: ['关系类型', '双方诉求', '权力差', '信任', '债务', '变化原因'] },
  event: { label: '事件', fields: ['起因', '参与者', '过程', '后果', '故事时间', '读者何时获知'] },
  foreshadowing: {
    label: '伏笔',
    fields: ['真实答案', '首次证据', '误导解释', '知情人物', '揭晓窗口', '回收状态'],
  },
};
const defaultAuthorFields = new Set([
  '秘密',
  '真实答案',
  '欲望',
  '弱点',
  '恐惧与弱点',
  '内在需要',
  '人物弧',
  '误导解释',
]);
export function fieldVisibility(entity: Pick<Entity, 'fieldVisibility'>, field: string): 'public' | 'author' {
  return entity.fieldVisibility?.[field] ?? (defaultAuthorFields.has(field) ? 'author' : 'public');
}
/** Author-only material can inform planning/review; it is never direct narrator knowledge. */
export function projectEntity(entity: Entity, prose: boolean): Entity {
  return {
    ...entity,
    fields: Object.fromEntries(
      Object.entries(entity.fields).filter(
        ([field]) => !prose || fieldVisibility(entity, field) === 'public',
      ),
    ),
  };
}
