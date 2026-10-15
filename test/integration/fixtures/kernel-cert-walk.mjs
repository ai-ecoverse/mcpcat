export default async function main(ctx) {
  const out = [];
  const errs = [];
  const skip = new Set(['/proc', '/dev', '/sys', '/node_modules', '/usr', '/bin', '/sbin', '/lib']);
  const st = async (p) => {
    for (const f of ['lstat', 'stat']) {
      if (typeof ctx.fs[f] === 'function') {
        try {
          return await ctx.fs[f](p);
        } catch {}
      }
    }
    return null;
  };
  async function walk(d, depth) {
    let names;
    try {
      names = await ctx.fs.readdir(d);
    } catch (e) {
      errs.push(`${d}:${e.code || e.message}`);
      return;
    }
    for (const n of names) {
      const name = typeof n === 'string' ? n : n.name;
      const p = d === '/' ? `/${name}` : `${d}/${name}`;
      if (skip.has(p)) continue;
      const s = await st(p);
      let isDir = false;
      if (s) {
        if (typeof s.isDirectory === 'function') isDir = s.isDirectory();
        else if (s.kind) isDir = s.kind === 'directory' || s.kind === 'dir';
        else if (s.type) isDir = s.type === 'directory' || s.type === 'dir';
        else if (typeof s.mode === 'number') isDir = (s.mode & 0o170000) === 0o040000;
      }
      const mode = s && typeof s.mode === 'number' ? (s.mode & 0o7777).toString(8) : '?';
      out.push(`${p}\t${mode}\t${s?.uid ?? ''}\t${isDir ? 'd' : (s?.size ?? '')}`);
      if (isDir && depth < 30) await walk(p, depth + 1);
    }
  }
  await walk('/', 0);
  await ctx.write(1, new TextEncoder().encode(`${out.join('\n')}\n`));
  if (errs.length)
    await ctx.write(2, new TextEncoder().encode(`${errs.slice(0, 20).join('\n')}\n`));
  return 0;
}
