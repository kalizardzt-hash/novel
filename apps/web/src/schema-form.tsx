import type { ReactNode } from 'react';
// A small reusable renderer for the object/array/scalar schemas used by planning contracts.
export type FormSchema = {
  type?: string;
  properties?: Record<string, FormSchema>;
  items?: FormSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};
function initial(schema: FormSchema): unknown {
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [key, initial(value)]),
    );
  if (schema.type === 'array') return [];
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return false;
  return '';
}
export function SchemaForm({
  schema,
  value,
  change,
  labels,
  name = '',
}: {
  schema: FormSchema;
  value: unknown;
  change: (value: unknown) => void;
  labels: Record<string, string>;
  name?: string;
}): ReactNode {
  if (schema.type === 'object') {
    const object = (value ?? {}) as Record<string, unknown>;
    return (
      <div className="proposal-fields">
        {Object.entries(schema.properties ?? {}).map(([key, child]) => (
          <SchemaForm
            key={key}
            schema={child}
            value={object[key]}
            change={(next) => change({ ...object, [key]: next })}
            labels={labels}
            name={labels[key] ?? key}
          />
        ))}
      </div>
    );
  }
  if (schema.type === 'array') {
    const values = Array.isArray(value) ? value : [];
    const child = schema.items ?? { type: 'string' };
    return (
      <fieldset className="proposal-array">
        <legend>{name}</legend>
        {values.map((item, index) => (
          <div className="proposal-item" key={index}>
            <SchemaForm
              schema={child}
              value={item}
              change={(next) => change(values.map((v, i) => (i === index ? next : v)))}
              labels={labels}
              name={`${name} ${index + 1}`}
            />
            <button
              type="button"
              className="text-button"
              disabled={values.length <= (schema.minItems ?? 0)}
              onClick={() => change(values.filter((_, i) => i !== index))}
            >
              移除第 {index + 1} 项
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={values.length >= (schema.maxItems ?? Infinity)}
          onClick={() => change([...values, initial(child)])}
        >
          添加{name}
        </button>
      </fieldset>
    );
  }
  return (
    <label className="field">
      <span>{name}</span>
      {schema.type === 'integer' || schema.type === 'number' ? (
        <input
          type="number"
          value={Number(value ?? 1)}
          min={schema.minimum}
          max={schema.maximum}
          onChange={(event) => change(Number(event.target.value))}
        />
      ) : (
        <textarea rows={2} value={String(value ?? '')} onChange={(event) => change(event.target.value)} />
      )}
    </label>
  );
}
