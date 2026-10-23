import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const TEMPLATE_COMMIT = '547d65fa394c386a44138e5849b1d43505a1bd15';
const WEBSITE_ID = 'f2eba9a1-169b-4a42-bd92-26387b1c6ffd';
const START = '    <!-- Umami: isolated from the game and loaded after normal page loading. -->';
const END = '    <!-- /Umami -->';
const HASHES = {
  bootstrap: '818b60d6fa59c27ebc02f56b8897c4f5c6c1c9e75d93b44779f436365bf1274f',
  frame: '4078613d2e83b0c8e43b4aa7595d10a8a227ede0add67237227d6c7f12221e49',
  check: '6c67a955c528579f6af4ff0a95695b6f0a6da6714fbde67974f5f5642a08514d'
};
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (base,file) => file === base || file.startsWith(base + path.sep);
const occurrences = (text,part) => text.split(part).length - 1;

function overlayRange(html) {
  if (!html.includes('<!-- Umami:') && !html.includes(END.trim())) {
    assert(!html.includes('erzhong-visit-stats'), 'Unrecognized analytics loader; review it before publishing');
    return null;
  }
  assert.equal(occurrences(html,START),1,'Missing or duplicate analytics start marker');
  assert.equal(occurrences(html,END),1,'Missing or duplicate analytics end marker');
  const start = html.indexOf(START);
  let end = html.indexOf(END) + END.length;
  assert(end > start,'Invalid analytics marker order');
  if (html.slice(end,end+2) === '\r\n') end += 2;
  else if (html[end] === '\n') end++;
  return {start,end};
}

function templates(repo) {
  // Checkout fetches full history. Immutable, previously verified templates
  // survive replacement/deletion of the current root deployment files.
  const fromGit = file => execFileSync('git',['show',`${TEMPLATE_COMMIT}:${file}`],{cwd:repo});
  const original = fromGit('index.html').toString('utf8');
  const range = overlayRange(original);
  const result = {
    bootstrap: original.slice(range.start,range.end),
    frame: fromGit('umami-frame.html'),
    check: fromGit('umami-check.html')
  };
  for (const name of Object.keys(HASHES)) assert.equal(hash(result[name]),HASHES[name],`Analytics template changed: ${name}`);
  assert(result.bootstrap.includes("frame.sandbox = 'allow-scripts'"));
  assert(!result.bootstrap.includes('allow-same-origin'));
  assert(result.frame.toString('utf8').includes(WEBSITE_ID));
  return result;
}

function withAnalytics(html,canonical) {
  const range = overlayRange(html);
  if (range) {
    assert.equal(html.slice(range.start,range.end).replace(/\r\n/g,'\n'),canonical,'Unrecognized analytics changes; refusing to publish');
    return html;
  }
  const endings = [...html.matchAll(/<\/body\s*>/gi)];
  assert.equal(endings.length,1,'Expected one closing body tag');
  const bodyEnd = endings[0].index;
  const lineStart = html.lastIndexOf('\n',bodyEnd) + 1;
  const at = /^[\t ]*$/.test(html.slice(lineStart,bodyEnd)) ? lineStart : bodyEnd;
  const after = html.slice(0,at) + canonical + html.slice(at);
  assert.equal(after.replace(canonical,''),html,'Changes outside analytics loader');
  return after;
}

async function gameFiles(root) {
  const files = [];
  async function add(name,required = true) {
    let stat;
    try { stat = await fs.lstat(path.join(root,name)); }
    catch(error) { if(!required && error.code === 'ENOENT') return; throw error; }
    assert(!stat.isSymbolicLink(),`Symlinks are not allowed: ${name}`);
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(path.join(root,name))).sort()) await add(`${name}/${child}`);
    } else {
      assert(stat.isFile(),`Not a regular file: ${name}`);
      files.push(name);
    }
  }
  await add('index.html');
  await add('version.json');
  await add('assets');
  await add('favicon.svg',false);
  return files.sort();
}

async function build(input,output,canonical) {
  const repo = await fs.realpath(input);
  const out = path.join(await fs.realpath(path.dirname(path.resolve(output))),path.basename(output));
  assert(!inside(repo,out) && !inside(out,repo),'Publish output must be separate from the repository');
  const names = await gameFiles(repo);
  const content = new Map();
  for(const name of names) content.set(name,await fs.readFile(path.join(repo,name)));
  const before = content.get('index.html').toString('utf8');
  const version = JSON.parse(content.get('version.json').toString('utf8'));
  assert.equal(typeof version.version,'string','Missing release version');
  // Fail before upload if a new entry points to an asset not yet committed.
  for (const match of before.matchAll(/(?:src|href)=["']\.\/([^"'#?]+)(?:[?#][^"']*)?["']/g)) {
    if (match[1].startsWith('assets/')) assert(content.has(match[1]),`Entry asset is missing: ${match[1]}`);
  }
  const after = withAnalytics(before,canonical.bootstrap);
  content.set('index.html',Buffer.from(after));
  content.set('umami-frame.html',canonical.frame);
  content.set('umami-check.html',canonical.check);
  content.set('.nojekyll',Buffer.alloc(0));
  const records = [...content].map(([name,data])=>({path:name,bytes:data.length,sha256:hash(data)})).sort((a,b)=>a.path.localeCompare(b.path));
  // Never clear or overwrite an existing staging directory.
  await fs.mkdir(out);
  for (const [name,data] of content) {
    const file = path.join(out,name);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,data);
    assert.equal(hash(await fs.readFile(file)),hash(data),`Staging copy differs: ${name}`);
  }
  for (const name of names.filter(name=>name !== 'index.html')) {
    assert.equal(hash(await fs.readFile(path.join(out,name))),hash(await fs.readFile(path.join(repo,name))),`Game resource changed: ${name}`);
  }
  const report = {
    schemaVersion:1,builtAtUtc:new Date().toISOString(),
    sourceCommit:process.env.GITHUB_SHA || null,version,
    analytics:{websiteId:WEBSITE_ID,templateCommit:TEMPLATE_COMMIT,sandbox:'allow-scripts',automatic:true},
    originalIndexSha256:hash(before),publishedIndexSha256:hash(after),
    gameFilesUnchanged:true,files:records
  };
  await fs.writeFile(path.join(out,'deployment-manifest.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}

async function selfTest(canonical) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'erzhong-pages-tests-'));
  const checks = [];
  const original = '<!doctype html>\n<html><head><script type="module" src="./assets/future-game.js"></script></head><body><div id="app"></div>\n  </body></html>\n';
  const once = withAnalytics(original,canonical.bootstrap);
  assert.equal(once.replace(canonical.bootstrap,''),original);
  assert.equal(withAnalytics(once,canonical.bootstrap),once);
  checks.push('Raw future entry gains analytics once; repeat builds do not duplicate it');
  assert.throws(()=>withAnalytics(once+canonical.bootstrap,canonical.bootstrap));
  assert.throws(()=>withAnalytics(once.replace("frame.sandbox = 'allow-scripts'","frame.sandbox = 'allow-scripts allow-same-origin'"),canonical.bootstrap));
  assert.throws(()=>withAnalytics(original.replace('</body>',''),canonical.bootstrap));
  checks.push('Duplicate, altered, and malformed loaders fail before publication');
  const fixture = path.join(temp,'repo');
  await fs.mkdir(path.join(fixture,'assets'),{recursive:true});
  await fs.writeFile(path.join(fixture,'index.html'),original);
  const version = '{"version":"999.0.0","buildId":"future-release"}';
  const game = 'window.syntheticGame=true;';
  await fs.writeFile(path.join(fixture,'version.json'),version);
  await fs.writeFile(path.join(fixture,'assets/future-game.js'),game);
  // These omitted or overwritten root files are restored from pinned templates.
  await fs.writeFile(path.join(fixture,'umami-frame.html'),'obsolete frame');
  await fs.writeFile(path.join(fixture,'save.json'),'TEST-ONLY MUST NOT BE PUBLISHED');
  const out = path.join(temp,'published');
  const report = await build(fixture,out,canonical);
  assert.equal(await fs.readFile(path.join(fixture,'index.html'),'utf8'),original);
  assert.equal(await fs.readFile(path.join(out,'assets/future-game.js'),'utf8'),game);
  assert.equal(await fs.readFile(path.join(out,'version.json'),'utf8'),version);
  assert.equal(await fs.readFile(path.join(out,'umami-frame.html'),'utf8'),canonical.frame.toString('utf8'));
  assert.equal(await fs.readFile(path.join(out,'umami-check.html'),'utf8'),canonical.check.toString('utf8'));
  await assert.rejects(fs.access(path.join(out,'save.json')));
  assert(report.gameFilesUnchanged);
  checks.push('Future release bytes and input files are unchanged; omitted/overwritten analytics is restored; saves are excluded');
  await assert.rejects(build(fixture,path.join(fixture,'out'),canonical));
  await assert.rejects(build(fixture,out,canonical));
  await fs.writeFile(path.join(fixture,'index.html'),original.replace('future-game.js','missing.js'));
  await assert.rejects(build(fixture,path.join(temp,'missing-asset-output'),canonical));
  checks.push('Input-directory writes, existing-output overwrite and missing game assets are rejected');
  console.log(JSON.stringify({selfTests:'passed',checks}));
}

const repo = path.resolve(import.meta.dirname,'..');
const canonical = templates(repo);
if (process.argv[2] === '--self-test') await selfTest(canonical);
else if (process.argv[2] === '--build' && process.argv[3]) {
  const report = await build(repo,path.resolve(process.argv[3]),canonical);
  console.log(JSON.stringify({built:true,version:report.version,files:report.files.length,gameFilesUnchanged:true,analytics:report.analytics}));
} else throw Error('Use --self-test or --build <new separate output directory>');
