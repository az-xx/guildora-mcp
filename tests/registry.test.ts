import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_TOOLS, annotationsFor, inputShape, selectTools } from '../src/tools/registry.js';
import { PACK_NAMES } from '../src/tools/packs.js';

describe('tool registry', () => {
  it('has unique snake_case tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('assigns every tool to a known pack', () => {
    for (const t of ALL_TOOLS) expect(PACK_NAMES).toContain(t.pack);
  });

  it('keeps the core pack small', () => {
    const core = ALL_TOOLS.filter((t) => t.pack === 'core');
    expect(core.length).toBeGreaterThan(0);
    expect(core.length).toBeLessThanOrEqual(20);
  });

  it('has a useful, bounded description on every tool', () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.description.length, t.name).toBeLessThan(700);
      expect(t.title.length, t.name).toBeGreaterThan(3);
    }
  });

  it('never marks a tool both read-only and destructive', () => {
    for (const t of ALL_TOOLS) expect(t.readOnly && t.destructive, t.name).toBeFalsy();
  });

  it('only destructive tools take "confirm"', () => {
    for (const t of ALL_TOOLS) {
      const shape = inputShape(t);
      expect('confirm' in shape, t.name).toBe(t.destructive === true);
      expect('confirm' in t.input, `${t.name} must not declare confirm itself`).toBe(false);
    }
  });

  it('builds valid schemas for every tool', () => {
    for (const t of ALL_TOOLS) {
      expect(() => z.toJSONSchema(z.object(inputShape(t))), t.name).not.toThrow();
    }
  });

  it('sets MCP annotations from the tool flags', () => {
    for (const t of ALL_TOOLS) {
      const a = annotationsFor(t);
      expect(a.readOnlyHint).toBe(t.readOnly);
      expect(a.destructiveHint).toBe(t.destructive === true);
      if (t.readOnly) expect(a.idempotentHint).toBe(true);
    }
  });
});

describe('selectTools', () => {
  it('loads only the core pack by default', () => {
    const tools = selectTools(ALL_TOOLS, { packs: ['core'], readOnly: false });
    expect(tools.every((t) => t.pack === 'core')).toBe(true);
    expect(tools.map((t) => t.name)).toContain('send_message');
  });

  it('loads every tool with all packs', () => {
    expect(selectTools(ALL_TOOLS, { packs: PACK_NAMES, readOnly: false })).toHaveLength(
      ALL_TOOLS.length,
    );
  });

  it('hides every mutating tool in read-only mode', () => {
    const tools = selectTools(ALL_TOOLS, { packs: PACK_NAMES, readOnly: true });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.readOnly)).toBe(true);
    expect(tools.some((t) => t.destructive)).toBe(false);
    const names = tools.map((t) => t.name);
    expect(names).toContain('read_messages');
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('delete_message');
  });
});
