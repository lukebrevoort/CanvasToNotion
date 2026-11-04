/** Dummy Notion state, persisted by the test owner. Never uses global fetch. */
import { DETAILS_HEADING, NOTES_HEADING, ACTIVITY_HEADING } from '../../src/notion/blocks.js';
export type DummyProvider = { pages: Record<string, any>; calls: any[]; seq: number };
const text = (id: string, content: string, type = 'paragraph') => ({ id: `dummy-${id}`, object: 'block', type, [type]: { rich_text: [{ type: 'text', text: { content } }] } });
export function initialProvider(ids: number[]): DummyProvider {
  return { calls: [], seq: 0, pages: Object.fromEntries(ids.map(id => [`SYNTHETIC_page_${id}`, {
    properties: { 'Do Not Sync': { type: 'checkbox', checkbox: false }, Hidden: { type: 'checkbox', checkbox: true }, 'In Progress': { type: 'checkbox', checkbox: true } }, reads: 0,
    blocks: [text(`preface-${id}`, 'USER PREFACE'), text(`details-${id}`, DETAILS_HEADING, 'heading_2'), text(`facts-${id}`, 'OLD FACTS'), text(`notes-${id}`, NOTES_HEADING, 'heading_2'), text(`note-${id}`, 'USER NOTE'), text(`activity-${id}`, ACTIVITY_HEADING, 'heading_2'), text(`history-${id}`, 'HISTORICAL ACTIVITY')],
  }])) };
}
export function providerFetch(state: DummyProvider, persist: () => Promise<void>, mode: string, afterWrite?: () => void): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://notion.invalid' || init?.redirect !== 'manual' || init.credentials !== 'omit' || new Headers(init.headers).has('Authorization')) throw Error('Dummy HTTP fence');
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ path: url.pathname, method, body });
    const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
    let result: unknown;
    if (url.pathname.includes('/data_sources/')) result = list([{ id: `SYNTHETIC_page_${body.filter.number.equals}` }]);
    else if (url.pathname.startsWith('/v1/pages/')) {
      const id = url.pathname.split('/').at(-1)!; const page = state.pages[id];
      if (!page) throw Error('Unexpected dummy page');
      if (method === 'PATCH') { Object.assign(page.properties, body.properties); afterWrite?.(); }
      else { page.reads++; if (mode === 'late-frozen' && page.reads > 1) page.properties['Do Not Sync'].checkbox = true; }
      result = { id, archived: false, in_trash: false, properties: page.properties };
    } else if (url.pathname.endsWith('/children')) {
      const id = url.pathname.split('/').at(-2)!; const page = state.pages[id];
      if (!page) throw Error('Unexpected dummy blocks');
      if (method === 'GET') result = list(page.blocks);
      else {
        const created = body.children.map((b: any) => ({ ...b, id: `SYNTHETIC_block_${++state.seq}` }));
        const at = body.position?.type === 'start' ? 0 : body.position?.type === 'after_block' ? page.blocks.findIndex((b: any) => b.id === body.position.after_block.id) + 1 : page.blocks.length;
        page.blocks.splice(at, 0, ...created); result = list(created);
        await persist();
        if (mode === 'lost') throw Error('Dummy committed append response lost');
        if (mode === 'unsettled') return await new Promise<Response>(() => {});
      }
    } else if (url.pathname.startsWith('/v1/blocks/') && method === 'DELETE') {
      const id = url.pathname.split('/').at(-1)!;
      for (const page of Object.values(state.pages)) page.blocks = page.blocks.filter((b: any) => b.id !== id);
      result = { id };
    } else throw Error('Unexpected dummy HTTP endpoint');
    await persist(); return Response.json(result);
  };
}
