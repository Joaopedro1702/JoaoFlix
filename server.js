const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 3000;

const VIDEO = [
  '.mp4',
  '.m4v',
  '.webm',
  '.mkv',
  '.mov'
];

const IMG = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp'
];

const MOVIE_DIRS = [
  'filmes',
  'movies'
];

const SERIES_DIRS = [
  'series',
  'séries',
  'shows'
];

const FFMPEG =
  process.env.FFMPEG_PATH || 'ffmpeg';

const natural = new Intl.Collator('pt-BR', {
  numeric: true,
  sensitivity: 'base'
}).compare;


// ====================================================
// CACHE
// ====================================================

const CACHE_DIR = path.resolve(
  __dirname,
  '.meuflix-cache'
);

fs.mkdirSync(
  CACHE_DIR,
  { recursive: true }
);


// ====================================================
// METADADOS (ffprobe) — duração real, codecs e faixas de áudio
// ====================================================

const FFPROBE =
  process.env.FFPROBE_PATH ||
  FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, 'ffprobe'));

const META_FILE = path.join(CACHE_DIR, 'meta.json');
let metaCache = {};

try {
  metaCache = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
} catch {}

let saveTimer = null;

function saveMeta() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(
    () => fs.writeFile(META_FILE, JSON.stringify(metaCache), () => {}),
    1500
  );
}

// Assinatura do arquivo: se mudar, o cache é refeito.
function statKey(file) {
  try {
    const st = fs.statSync(file);
    return st.size + ':' + Math.floor(st.mtimeMs);
  } catch {
    return null;
  }
}

const probing = new Map();
const probeQueue = [];
let probeActive = 0;

function runProbe(file) {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      [
        '-v', 'error',
        '-show_entries',
        'format=duration:stream=codec_type,codec_name,profile,pix_fmt,level,height:stream_tags=language',
        '-of', 'json',
        file
      ],
      { maxBuffer: 1 << 22, windowsHide: true },
      (err, out) => {
        let m = null;

        if (!err) {
          try {
            const j = JSON.parse(out);
            const st = j.streams || [];
            const v = st.find((x) => x.codec_type === 'video');

            m = {
              k: statKey(file),
              ver: 2,
              pf: v ? v.pix_fmt : '',
              pr: v ? v.profile : '',
              lv: v ? v.level : 0,
              h: v ? v.height : 0,
              duration: Number(j.format && j.format.duration) || 0,
              v: v ? v.codec_name : '',
              a: st
                .filter((x) => x.codec_type === 'audio')
                .map((x) => ({
                  codec: x.codec_name,
                  lang: (x.tags && x.tags.language) || ''
                }))
            };

            metaCache[file] = m;
            saveMeta();
          } catch {}
        }

        resolve(m);
      }
    );
  });
}

function pumpProbes() {
  while (probeActive < 2 && probeQueue.length) {
    const { file, resolve } = probeQueue.shift();

    probeActive++;

    runProbe(file).then((m) => {
      probeActive--;
      probing.delete(file);
      resolve(m);
      pumpProbes();
    });
  }
}

// urgent = o usuário apertou play: não espera na fila.
function probe(file, urgent = false) {
  if (probing.has(file)) return probing.get(file);

  const p = urgent
    ? runProbe(file).finally(() => probing.delete(file))
    : new Promise((resolve) => {
        probeQueue.push({ file, resolve });
        pumpProbes();
      });

  probing.set(file, p);
  return p;
}

function metaFor(file, enqueue = true) {
  const m = metaCache[file];

  if (m && m.ver === 2 && m.k === statKey(file)) return m;

  if (enqueue) probe(file);

  return null;
}

const DIRECT_V = ['h264', 'vp9', 'av1'];
const DIRECT_A = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

// O vídeo pode ser copiado sem recodificar? TVs aceitam bem menos: só H.264 8 bits, até 1080p, nível 4.1.
function vSafe(m, tv) {
  if (!m) return !tv;

  if (m.v === 'h264') {
    return (
      (m.pf || 'yuv420p') === 'yuv420p' &&
      !/10|4:2:2|4:4:4/.test(m.pr || '') &&
      (m.lv || 0) <= 52 &&
      (!tv || (m.h || 0) <= 1080)
    );
  }

  if (m.v === 'hevc') return true;

  return !tv && ['vp9', 'av1'].includes(m.v);
}

// Decide faixa de áudio (prefere português) e se pode ser enviado direto, copiado ou recodificado.
function plan(file, m, tv = false, force = false) {
  const ext = path.extname(file).toLowerCase();
  const a = (m && m.a) || [];

  let ai = a.findIndex((x) => /^(por|pt|pob)/i.test(x.lang));

  if (ai < 0) ai = 0;

  const ac = a[ai] && a[ai].codec;
  const okA = tv ? ['aac', 'mp3'] : DIRECT_A;
  const vCopy = !force && vSafe(m, tv);

  const direct =
    vCopy &&
    ['.mp4', '.m4v', '.mov', '.webm'].includes(ext) &&
    (!m ||
      (DIRECT_V.includes(m.v) && ai === 0 && (!ac || okA.includes(ac))));

  const aCopy =
    !force && !tv && !!m && ['aac', 'mp3'].includes(ac);

  return { ai, direct, vCopy, aCopy };
}


// ====================================================
// UTILITÁRIOS
// ====================================================

const enc = (s) =>
  Buffer.from(s).toString('base64url');

const dec = (s) =>
  Buffer.from(s, 'base64url').toString();

function ls(dir) {
  try {
    return fs.readdirSync(dir, {
      withFileTypes: true
    });
  } catch {
    return [];
  }
}

function clean(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isVideo(name) {
  return VIDEO.includes(
    path.extname(name).toLowerCase()
  );
}

function episodeNumber(name) {
  const m = name.match(
    /S(\d{1,2})E(\d{1,2})/i
  );

  return m ? Number(m[2]) : null;
}

function seasonNumber(name) {
  let m = name.match(
    /(?:temporada|season)\s*(\d{1,2})/i
  );

  if (m) {
    return Number(m[1]);
  }

  m = name.match(/^S(\d{1,2})$/i);

  return m ? Number(m[1]) : null;
}

function episodeTitle(file) {
  const n = episodeNumber(
    path.basename(file)
  );

  return n !== null
    ? `Episódio ${n}`
    : clean(path.basename(file));
}


// ====================================================
// DIRETÓRIOS
// ====================================================

function findDir(root, names) {
  const e = ls(root).find(
    (x) =>
      x.isDirectory() &&
      names.includes(
        x.name.toLowerCase()
      )
  );

  return e
    ? path.join(root, e.name)
    : null;
}

function isLibrary(root) {
  return !!(
    findDir(root, MOVIE_DIRS) ||
    findDir(root, SERIES_DIRS)
  );
}


// ====================================================
// DETECÇÃO DE DISPOSITIVOS
// ====================================================

function candidates() {
  if (process.platform === 'win32') {
    return [...'CDEFGHIJKLMNOPQRSTUVWXYZ']
      .map((l) => `${l}:\\`);
  }

  if (process.platform === 'darwin') {
    return ls('/Volumes').map(
      (e) =>
        path.join(
          '/Volumes',
          e.name
        )
    );
  }

  const out = [];

  for (const base of [
    '/media',
    '/run/media',
    '/mnt'
  ]) {
    for (const e of ls(base)) {
      if (!e.isDirectory()) continue;

      const p = path.join(
        base,
        e.name
      );

      out.push(p);

      for (const s of ls(p)) {
        if (s.isDirectory()) {
          out.push(
            path.join(
              p,
              s.name
            )
          );
        }
      }
    }
  }

  return out;
}

const manual = [
  ...process.argv.slice(2),
  ...(process.env.MEDIA_DIRS || '')
    .split(path.delimiter)
]
  .filter(Boolean)
  .map((p) => path.resolve(p));

if (!manual.length) {
  const d = path.resolve('./media');

  fs.mkdirSync(
    path.join(d, 'Filmes'),
    { recursive: true }
  );

  fs.mkdirSync(
    path.join(d, 'Series'),
    { recursive: true }
  );

  manual.push(d);
}

let roots = new Map();

function detect() {
  const found = new Map();

  for (const p of [
    ...manual,
    ...candidates()
  ]) {
    if (!isLibrary(p)) continue;

    const key = crypto
      .createHash('sha1')
      .update(p.toLowerCase())
      .digest('hex')
      .slice(0, 8);

    const label =
      path.parse(p).root === p
        ? p.replace(/[\\/]$/, '')
        : path.basename(p);

    found.set(key, {
      key,
      path: p,
      label
    });
  }

  roots = found;
}


// ====================================================
// BUSCA CONTROLADA DE VÍDEOS
// ====================================================

function walkVideosShallow(
  dir,
  maxDepth = 1
) {
  const out = [];

  function visit(current, depth) {
    for (const e of ls(current)) {
      const p = path.join(
        current,
        e.name
      );

      if (
        e.isFile() &&
        isVideo(e.name)
      ) {
        out.push(p);
      } else if (
        e.isDirectory() &&
        depth < maxDepth
      ) {
        visit(
          p,
          depth + 1
        );
      }
    }
  }

  visit(dir, 0);

  return out;
}


// ====================================================
// LEGENDAS
// ====================================================

function subFile(file) {
  const base = path.basename(
    file,
    path.extname(file)
  );

  const e = ls(
    path.dirname(file)
  ).find(
    (x) =>
      x.name.startsWith(base) &&
      /\.(srt|vtt)$/i.test(x.name)
  );

  return e
    ? path.join(
        path.dirname(file),
        e.name
      )
    : null;
}


// ====================================================
// IDS
// ====================================================

function makeRef(root, file) {
  return (
    root.key +
    '.' +
    enc(
      path.relative(
        root.path,
        file
      )
    )
  );
}

function makeEpisode(root, file) {
  const m = metaFor(file);

  return {
    id: makeRef(root, file),

    key: enc(
      path.relative(
        root.path,
        file
      )
    ),

    title: episodeTitle(file),

    originalTitle: clean(
      path.basename(file)
    ),

    sub: !!subFile(file),

    duration: m ? m.duration : 0,

    direct: plan(file, m).direct
  };
}


// ====================================================
// POSTERS
// ====================================================

// Procura a capa de um título. Ordem: nome do vídeo (filme solto) > nome da pasta > poster/folder/cover/capa/thumb.
// Em pastas exclusivas do título (any = true), qualquer imagem da pasta serve como último recurso.
// A comparação ignora maiúsculas/minúsculas e a extensão (jpg, jpeg, png, webp).
function findPoster(
  root,
  dir,
  base = null,
  any = false
) {
  const imgs = ls(dir).filter(
    (e) =>
      e.isFile() &&
      IMG.includes(path.extname(e.name).toLowerCase())
  );

  if (!imgs.length) return null;

  const stem = (e) =>
    path.basename(e.name, path.extname(e.name)).toLowerCase();

  const names = base
    ? [base]
    : [path.basename(dir), 'poster', 'folder', 'cover', 'capa', 'thumb'];

  for (const n of names) {
    const hit = imgs.find((e) => stem(e) === n.toLowerCase());

    if (hit) return '/img/' + makeRef(root, path.join(dir, hit.name));
  }

  if (any) {
    const pool = imgs.filter((e) => !isBackdropName(stem(e)));

    if (pool.length) {
      const first = pool.sort((x, y) => natural(x.name, y.name))[0];

      return '/img/' + makeRef(root, path.join(dir, first.name));
    }
  }

  return null;
}

// Imagem larga (paisagem, ex.: 1920x1080) usada no destaque do topo.
// Nomes: backdrop, fanart, banner, background, hero, landscape (pasta do título)
// ou <nome-do-video>-backdrop (filme solto).
const BACKDROP_NAMES = ['backdrop', 'fanart', 'banner', 'background', 'hero', 'landscape'];

const isBackdropName = (stem) =>
  BACKDROP_NAMES.some((n) => stem === n || stem.endsWith('-' + n) || stem.endsWith('.' + n));

function findBackdrop(root, dir, base = null) {
  const imgs = ls(dir).filter(
    (e) => e.isFile() && IMG.includes(path.extname(e.name).toLowerCase())
  );

  const names = base
    ? BACKDROP_NAMES.flatMap((n) => [`${base}-${n}`, `${base}.${n}`])
    : BACKDROP_NAMES;

  for (const n of names) {
    const hit = imgs.find(
      (e) => path.basename(e.name, path.extname(e.name)).toLowerCase() === n.toLowerCase()
    );

    if (hit) return '/img/' + makeRef(root, path.join(dir, hit.name));
  }

  return null;
}


// ====================================================
// TEMPORADAS
// ====================================================

function seasonName(dir) {
  const n = path.basename(dir);

  const number =
    seasonNumber(n);

  return number !== null
    ? `Temporada ${number}`
    : clean(n);
}

function buildSeason(
  root,
  seasonDir
) {
  const episodes = [];
  const seen = new Set();

  // Arquivos diretamente dentro
  // da pasta da temporada.

  for (const e of ls(seasonDir)) {
    if (
      !e.isFile() ||
      !isVideo(e.name)
    ) {
      continue;
    }

    const p = path.join(
      seasonDir,
      e.name
    );

    seen.add(
      p.toLowerCase()
    );

    episodes.push(
      makeEpisode(root, p)
    );
  }

  // Também aceita:
  //
  // Temporada 3
  // └── pasta do episódio
  //     └── arquivo.mkv

  for (const e of ls(seasonDir)) {
    if (!e.isDirectory()) {
      continue;
    }

    const folder = path.join(
      seasonDir,
      e.name
    );

    for (
      const f of walkVideosShallow(
        folder,
        1
      )
    ) {
      const key =
        f.toLowerCase();

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      episodes.push(
        makeEpisode(root, f)
      );
    }
  }

  episodes.sort(
    (a, b) =>
      natural(
        a.title,
        b.title
      )
  );

  return {
    name: seasonName(
      seasonDir
    ),

    episodes
  };
}


// ====================================================
// SÉRIE
// ====================================================

function buildSeries(
  root,
  showDir
) {
  const seasonDirs =
    ls(showDir)
      .filter(
        (e) =>
          e.isDirectory() &&
          seasonNumber(e.name) !== null
      )
      .map(
        (e) =>
          path.join(
            showDir,
            e.name
          )
      )
      .sort(
        (a, b) =>
          seasonNumber(
            path.basename(a)
          ) -
          seasonNumber(
            path.basename(b)
          )
      );

  const seasons =
    seasonDirs
      .map(
        (dir) =>
          buildSeason(
            root,
            dir
          )
      )
      .filter(
        (s) =>
          s.episodes.length > 0
      );

  // Episódios diretamente na pasta da série.

  const directEpisodes =
    ls(showDir)
      .filter(
        (e) =>
          e.isFile() &&
          isVideo(e.name)
      )
      .map(
        (e) =>
          makeEpisode(
            root,
            path.join(
              showDir,
              e.name
            )
          )
      )
      .sort(
        (a, b) =>
          natural(
            a.title,
            b.title
          )
      );

  if (directEpisodes.length) {
    seasons.unshift({
      name: 'Episódios',
      episodes:
        directEpisodes
    });
  }

  if (!seasons.length) {
    return null;
  }

  return {
    id: enc(
      path.relative(
        root.path,
        showDir
      )
    ),

    type: 'series',

    device: root.label,

    title: clean(
      path.basename(showDir)
    ),

    poster: findPoster(root, showDir, null, true),
    backdrop: findBackdrop(root, showDir),

    seasons
  };
}


// ====================================================
// SÉRIES
// ====================================================

function scanSeries(
  root,
  sdir
) {
  const out = [];
  const entries = ls(sdir);

  // Estrutura normal:
  //
  // Series
  // └── A Casa do Dragão
  //     └── Temporada 3
  //         ├── Episodio 1.mkv
  //         └── Episodio 2.mkv

  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }

    // Não trata pastas S03E01
    // como séries novas.

    if (
      /S\d{1,2}E\d{1,2}/i.test(
        e.name
      )
    ) {
      continue;
    }

    const item =
      buildSeries(
        root,
        path.join(
          sdir,
          e.name
        )
      );

    if (item) {
      out.push(item);
    }
  }

  // Compatibilidade com estrutura antiga.

  const legacy =
    new Map();

  for (const e of entries) {
    if (
      !e.isDirectory() ||
      !/S\d{1,2}E\d{1,2}/i.test(
        e.name
      )
    ) {
      continue;
    }

    const match =
      e.name.match(
        /^(.*?)\.?S(\d{1,2})E(\d{1,2})/i
      );

    if (!match) {
      continue;
    }

    const title =
      clean(match[1]) ||
      'Série';

    const seasonNo =
      Number(match[2]);

    const folder =
      path.join(
        sdir,
        e.name
      );

    const videos =
      walkVideosShallow(
        folder,
        2
      );

    if (!videos.length) {
      continue;
    }

    if (!legacy.has(title)) {
      legacy.set(
        title,
        new Map()
      );
    }

    const seasons =
      legacy.get(title);

    if (!seasons.has(seasonNo)) {
      seasons.set(
        seasonNo,
        []
      );
    }

    for (const f of videos) {
      seasons
        .get(seasonNo)
        .push(
          makeEpisode(
            root,
            f
          )
        );
    }
  }

  for (
    const [title, seasonMap]
    of legacy
  ) {
    const seasons =
      [...seasonMap.entries()]
        .sort(
          ([a], [b]) => a - b
        )
        .map(
          ([n, episodes]) => ({
            name:
              `Temporada ${n}`,

            episodes:
              episodes.sort(
                (a, b) =>
                  natural(
                    a.title,
                    b.title
                  )
              )
          })
        );

    out.push({
      id: enc(
        `legacy:${root.key}:${title}`
      ),

      type: 'series',

      device: root.label,

      title,

      poster: null,

      seasons
    });
  }

  return out;
}


// ====================================================
// SCAN DA BIBLIOTECA
// ====================================================

function scanRoot(root) {
  const out = [];

  // FILMES

  const fdir =
    findDir(
      root.path,
      MOVIE_DIRS
    );

  if (fdir) {
    for (const e of ls(fdir)) {
      const p =
        path.join(
          fdir,
          e.name
        );

      let file = null;

      if (
        e.isFile() &&
        isVideo(e.name)
      ) {
        file = p;
      } else if (
        e.isDirectory()
      ) {
        file =
          walkVideosShallow(
            p,
            1
          )[0] || null;
      }

      if (!file) {
        continue;
      }

      out.push({
        id: enc(
          path.relative(
            root.path,
            p
          )
        ),

        type: 'movie',

        device: root.label,

        title: clean(e.name),

        poster:
          e.isDirectory()
            ? findPoster(root, p, null, true)
            : findPoster(
                root,
                path.dirname(file),
                path.basename(
                  file,
                  path.extname(file)
                )
              ),
        backdrop:
          e.isDirectory()
            ? findBackdrop(root, p)
            : findBackdrop(root, path.dirname(file), path.basename(file, path.extname(file))),

        seasons: [
          {
            name: '',

            episodes: [
              makeEpisode(
                root,
                file
              )
            ]
          }
        ]
      });
    }
  }

  // SÉRIES

  const sdir =
    findDir(
      root.path,
      SERIES_DIRS
    );

  if (sdir) {
    out.push(
      ...scanSeries(
        root,
        sdir
      )
    );
  }

  return out;
}

function scan() {
  const all = [];
  const seen = new Set();

  for (
    const root of roots.values()
  ) {
    for (
      const item of scanRoot(root)
    ) {
      let id = item.id;

      if (seen.has(id)) {
        id += '~' + root.key;
      }

      seen.add(id);

      all.push({
        ...item,
        id,
        rootKey: root.key
      });
    }
  }

  return all.sort(
    (a, b) =>
      natural(
        a.title,
        b.title
      )
  );
}


// ====================================================
// RESOLVE ID
// ====================================================

function resolveId(id) {
  const dot =
    id.indexOf('.');

  if (dot < 0) {
    return null;
  }

  const key =
    id.slice(
      0,
      dot
    );

  const encoded =
    id.slice(
      dot + 1
    );

  if (!roots.has(key)) {
    detect();
  }

  const root =
    roots.get(key);

  if (!root) {
    console.error(
      '[resolveId] Root não encontrada:',
      key
    );

    return null;
  }

  let relative;

  try {
    relative =
      dec(encoded);
  } catch (err) {
    console.error(
      '[resolveId] Erro ao decodificar:',
      err.message
    );

    return null;
  }

  const abs =
    path.resolve(
      root.path,
      relative
    );

  const rootAbs =
    path.resolve(
      root.path
    );

  // Corrige raízes como D:\
  const rootPrefix =
    rootAbs.endsWith(path.sep)
      ? rootAbs
      : rootAbs + path.sep;

  // Proteção contra path traversal
  if (
    abs !== rootAbs &&
    !abs.startsWith(rootPrefix)
  ) {
    console.error(
      '[resolveId] Caminho fora da raiz:',
      abs
    );

    return null;
  }

  return abs;
}


// ====================================================
// CACHE FFMPEG
// ====================================================

function cacheName(source) {
  return crypto
    .createHash('sha1')
    .update(
      path.resolve(
        source
      ).toLowerCase()
    )
    .digest('hex');
}

const conversions =
  new Map();

function ensureCachedMp4(source) {
  const hash =
    cacheName(source);

  const target =
    path.join(
      CACHE_DIR,
      `${hash}.mp4`
    );

  const temp =
    path.join(
      CACHE_DIR,
      `${hash}.part.mp4`
    );

  // Cache já existente

  try {
    const st =
      fs.statSync(
        target
      );

    if (
      st.isFile() &&
      st.size > 1024
    ) {
      console.log(
        '[CACHE] Usando arquivo existente:',
        target
      );

      return Promise.resolve(
        target
      );
    }
  } catch {}

  // Conversão já em andamento

  if (
    conversions.has(source)
  ) {
    console.log(
      '[CACHE] Conversão já está em andamento.'
    );

    return conversions.get(
      source
    );
  }

  const promise =
    new Promise(
      (resolve, reject) => {

        try {
          if (
            fs.existsSync(temp)
          ) {
            fs.rmSync(
              temp,
              {
                force: true
              }
            );
          }
        } catch (err) {
          console.warn(
            '[CACHE] Não consegui limpar temporário:',
            err.message
          );
        }

        console.log(
          '[FFmpeg] Convertendo para cache:'
        );

        console.log(
          'Origem:',
          source
        );

        console.log(
          'Destino:',
          temp
        );

        const ff =
          spawn(
            FFMPEG,
            [
              '-hide_banner',

              '-loglevel',
              'info',

              '-i',
              source,

              // Primeiro vídeo
              '-map',
              '0:v:0',

              // PRIMEIRA faixa de áudio
              // Português no seu arquivo
              '-map',
              '0:a:0',

              // Vídeo sem recodificação
              '-c:v',
              'copy',

              // E-AC3 -> AAC
              '-c:a',
              'aac',

              '-b:a',
              '192k',

              // 5.1 -> estéreo
              '-ac',
              '2',

              // MP4 com duração correta
              '-movflags',
              '+faststart',

              '-f',
              'mp4',

              temp
            ],
            {
              windowsHide: true
            }
          );

        let stderr = '';

        ff.stderr.on(
          'data',
          (data) => {
            const msg =
              data.toString();

            stderr += msg;

            process.stdout.write(
              '[FFmpeg] ' + msg
            );
          }
        );

        ff.on(
          'error',
          (err) => {
            conversions.delete(
              source
            );

            reject(
              new Error(
                `Erro ao iniciar FFmpeg: ${err.message}`
              )
            );
          }
        );

        ff.on(
          'close',
          (code) => {

            console.log(
              '[FFmpeg] terminou com código:',
              code
            );

            if (code === 0) {
              try {

                fs.renameSync(
                  temp,
                  target
                );

                conversions.delete(
                  source
                );

                console.log(
                  '[CACHE] Conversão concluída:'
                );

                console.log(
                  target
                );

                resolve(
                  target
                );

              } catch (err) {

                conversions.delete(
                  source
                );

                reject(
                  new Error(
                    `Erro ao finalizar cache: ${err.message}`
                  )
                );
              }

              return;
            }

            conversions.delete(
              source
            );

            try {
              fs.rmSync(
                temp,
                {
                  force: true
                }
              );
            } catch {}

            reject(
              new Error(
                `FFmpeg terminou com código ${code}\n${stderr}`
              )
            );
          }
        );
      }
    );

  conversions.set(
    source,
    promise
  );

  return promise;
}


// ====================================================
// STREAM
// ====================================================

// ====================================================
// CONSUMO DE CPU
// ====================================================

const THREADS = Math.max(2, Math.floor(os.cpus().length / 2));
let HAS_READRATE = false;
let HAS_BURST = false;
let HW = null;

// Encoders de hardware, na ordem de tentativa. Só vale se um quadro de teste for codificado.
const HW_TRY = [
  ['h264_nvenc', ['-preset', 'p3', '-rc', 'vbr', '-cq', '27', '-b:v', '0']],
  ['h264_qsv', ['-global_quality', '27', '-preset', 'veryfast']],
  ['h264_amf', ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '27', '-qp_p', '27']],
  ['h264_videotoolbox', ['-b:v', '6M']]
];

function probeHw(i = 0) {
  if (process.env.NO_HW || i >= HW_TRY.length) {
    console.log('[ffmpeg] sem encoder de hardware: x264 leve, ' + THREADS + ' threads');
    return;
  }

  const [enc, opts] = HW_TRY[i];

  execFile(
    FFMPEG,
    ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:d=0.1',
     '-frames:v', '1', '-c:v', enc, '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
    { windowsHide: true, timeout: 15000 },
    (err) => {
      if (err) return probeHw(i + 1);

      HW = { enc, opts };
      console.log('[ffmpeg] encoder de hardware:', enc);
    }
  );
}

execFile(
  FFMPEG,
  ['-hide_banner', '-h', 'full'],
  { maxBuffer: 1 << 27, windowsHide: true },
  (err, out) => {
    if (err) return;

    HAS_READRATE = /-readrate\b/.test(out);
    HAS_BURST = /readrate_initial_burst/.test(out);
    probeHw();
  }
);

// Prioridade baixa: o PC continua responsivo enquanto o ffmpeg trabalha.
function lowPriority(ff) {
  try {
    os.setPriority(ff.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
}


// Só recodificação pesa: usa decodificação por hardware quando possível e
// limita a leitura a 1,5x o tempo real (não codifica o filme inteiro de uma vez).
function inputOpts(p) {
  if (p.vCopy) return [];

  const o = ['-hwaccel', 'auto'];

  if (HAS_READRATE) {
    o.push('-readrate', '1.5');
    if (HAS_BURST) o.push('-readrate_initial_burst', '15');
  }

  return o;
}

function baseArgs(file, m, p, t) {
  const args = ['-hide_banner', '-loglevel', 'error'];

  // Com vídeo copiado, o corte só pode cair num keyframe. Sem -noaccurate_seek o áudio recodificado
  // começava no ponto exato e o vídeo no keyframe anterior (até alguns segundos de defasagem).
  // Com ele, os dois fluxos começam juntos no mesmo keyframe.
  if (t) args.push('-ss', String(t), ...(p.vCopy ? ['-noaccurate_seek'] : []));

  args.push(
    '-probesize', '10M',
    '-analyzeduration', '3M',
    ...inputOpts(p),
    '-i', file,
    '-map', '0:v:0',
    '-map', `0:a:${p.ai}?`,
    '-sn'
  );

  if (p.vCopy) {
    args.push('-c:v', 'copy');
    if (m && m.v === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    // H.264 8 bits, High@4.1, máx. 1080p, keyframe a cada 2 s (início rápido e seek).
    args.push('-vf', "scale=-2:'min(1080,ih)'");

    if (HW) {
      args.push('-c:v', HW.enc, ...HW.opts);
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'superfast',
        '-crf', '24',
        '-threads', String(THREADS),
        '-sc_threshold', '0'
      );
    }

    args.push('-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-g', '48');
  }

  if (p.aCopy) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }

  return args;
}



// ====================================================
// CACHE MP4: remuxa UMA vez (vídeo copiado + áudio AAC) e depois serve com Range
// ====================================================
const cacheJobs = new Map();
const cacheKey = (file, ai) =>
  crypto.createHash('sha1').update(path.resolve(file).toLowerCase() + ':a' + ai).digest('hex');
const cacheFile = (file, ai) => path.join(CACHE_DIR, `v2_${cacheKey(file, ai)}.mp4`);

function cachedMp4(file, ai) {
  try {
    const f = cacheFile(file, ai);
    return fs.statSync(f).size > 1024 ? f : null;
  } catch { return null; }
}

function startCache(file, ai, m) {
  const key = cacheKey(file, ai);
  if (cacheJobs.has(key) || cachedMp4(file, ai)) return;

  const out = cacheFile(file, ai);
  const part = out + '.part';
  fs.rmSync(part, { force: true });

  const ff = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-map', '0:v:0', '-map', `0:a:${ai}?`, '-sn',
    '-c:v', 'copy', ...(m && m.v === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-af', 'aresample=async=1',
    '-movflags', '+faststart', '-f', 'mp4', part
  ], { windowsHide: true });

  lowPriority(ff);
  cacheJobs.set(key, ff);
  console.log('[cache] convertendo em segundo plano:', path.basename(file));

  ff.stderr.on('data', (d) => console.error('[cache]', d.toString().trim()));
  ff.on('error', (e) => { cacheJobs.delete(key); console.error('[cache]', e.message); });
  ff.on('close', (code) => {
    cacheJobs.delete(key);
    try {
      if (code === 0) { fs.renameSync(part, out); console.log('[cache] pronto:', path.basename(file)); }
      else fs.rmSync(part, { force: true });
    } catch (e) { console.error('[cache]', e.message); }
  });
}

async function sendMedia(req, res) {
  const file = resolveId(req.params.id);

  if (!file || !fs.existsSync(file)) {
    return res.sendStatus(404);
  }

  const m = metaFor(file, false) || (await probe(file, true));
  const tv = req.query.tv === '1';
  const force = req.query.force === '1';
  const p = plan(file, m, tv, force);

  console.log(
    `[stream] ${path.basename(file)} | ${m ? m.v + ' ' + m.pr + ' ' + m.pf + ' ' + m.h + 'p' : 'sem ffprobe'} | tv=${tv} force=${force} -> ` +
      (p.direct ? 'direto' : p.vCopy ? 'remux' : 'recodificando vídeo')
  );

  // Arquivo compatível: envio direto com suporte a Range.
  // Início instantâneo e seek nativo, sem ffmpeg.
  if (p.direct) {
    return res.sendFile(file);
  }

  // Demais casos (MKV etc.): remux em tempo real.
  // ?t= começa o stream no segundo pedido, o que permite pular no vídeo.
  const t = Math.max(0, Number(req.query.t) || 0);

  let cached = null;

  if (p.vCopy && !tv) {
    cached = cachedMp4(file, p.ai);

    // Cache pronto e início do filme: arquivo inteiro com Range, sem ffmpeg ao vivo.
    if (cached && t === 0) return res.sendFile(cached);

    if (!cached) startCache(file, p.ai, m);
  }

  // Seek com cache: copia vídeo E áudio (ambos no mesmo keyframe) => sem dessincronia.
  const args = cached
    ? ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', cached,
       '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero']
    : baseArgs(file, m, p, t);

  args.push(
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-flush_packets', '1',
    '-f', 'mp4',
    'pipe:1'
  );

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders();

  const ff = spawn(FFMPEG, args, { windowsHide: true });
  lowPriority(ff);

  ff.stdout.pipe(res);

  ff.stderr.on('data', (d) => {
    const msg = d.toString().trim();

    if (msg) console.error('[FFmpeg]', msg);
  });

  ff.on('error', (err) => {
    console.error('[FFmpeg] Erro:', err.message);
    res.end();
  });

  // Player fechado ou seek: encerra o ffmpeg na hora.
  req.on('close', () => ff.kill());
}


// ====================================================
// IMAGENS
// ====================================================

function sendImage(
  req,
  res
) {
  const file =
    resolveId(
      req.params.id
    );

  if (
    !file ||
    !fs.existsSync(file)
  ) {
    return res.sendStatus(404);
  }

  return res.sendFile(file);
}


// ====================================================
// LEGENDAS
// ====================================================

function getSub(
  req,
  res
) {
  const file =
    resolveId(
      req.params.id
    );

  const subtitle =
    file &&
    subFile(file);

  if (
    !subtitle ||
    !fs.existsSync(subtitle)
  ) {
    return res.sendStatus(404);
  }

  let text =
    fs.readFileSync(
      subtitle,
      'utf8'
    )
    .replace(
      /^\uFEFF/,
      ''
    )
    .replace(
      /\r/g,
      ''
    );

  if (
    !text.startsWith(
      'WEBVTT'
    )
  ) {
    text =
      'WEBVTT\n\n' +
      text.replace(
        /(\d\d:\d\d:\d\d),(\d{3})/g,
        '$1.$2'
      );
  }

  res
    .type('text/vtt')
    .send(text);
}


// ====================================================
// EXPRESS
// ====================================================

const app =
  express();


// LOG HTTP
// O app já existe aqui.

app.use(
  (req, res, next) => {
    console.log(
      `[HTTP] ${req.method} ${req.url}`
    );

    next();
  }
);

app.disable(
  'x-powered-by'
);

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);


// ====================================================
// API
// ====================================================

// Cache de 20 s: o front consulta a cada poucos segundos e cada varredura lê o disco do filme.
let libCache = { t: 0, body: null };

app.use('/api/library', (req, res, next) => {
  if (libCache.body && Date.now() - libCache.t < 20000) return res.json(libCache.body);

  const send = res.json.bind(res);

  res.json = (b) => { libCache = { t: Date.now(), body: b }; return send(b); };
  next();
});

app.get(
  '/api/library',
  (_, res) => {
    detect();

    res.json({
      devices:
        [...roots.values()]
          .map(
            (r) => r.label
          ),

      items:
        scan()
    });
  }
);


// ====================================================
// ROTAS
// ====================================================

app.get(
  '/stream/:id',
  sendMedia
);

app.get('/api/meta/:id', async (req, res) => {
  const file = resolveId(req.params.id);

  if (!file || !fs.existsSync(file)) {
    return res.sendStatus(404);
  }

  const m = metaFor(file, false) || (await probe(file, true));
  const p = plan(file, m, req.query.tv === '1');

  res.json({
    duration: m ? m.duration : 0,
    codec: m ? [m.v, m.pf, m.pr].join('/') : '',
    direct: p.direct,
    audio: p.ai,
    audios: m ? m.a : []
  });
});

// ====================================================
// HLS (TVs): o ffmpeg grava segmentos e a TV reproduz a playlist
// ====================================================

const HLS_DIR = path.join(CACHE_DIR, 'hls');

fs.rmSync(HLS_DIR, { recursive: true, force: true });
fs.mkdirSync(HLS_DIR, { recursive: true });

const hlsSessions = new Map();

function endHls(sid) {
  const ses = hlsSessions.get(sid);

  if (!ses) return;

  try { ses.ff.kill(); } catch {}

  fs.rm(ses.dir, { recursive: true, force: true }, () => {});
  hlsSessions.delete(sid);
}

// Sessões abandonadas (TV desligada, aba fechada) são removidas após 10 min sem acesso.
setInterval(() => {
  for (const [sid, ses] of hlsSessions) {
    if (Date.now() - ses.last > 600000) endHls(sid);
  }
}, 30000);

app.get('/api/hls', async (req, res) => {
  const file = resolveId(String(req.query.id || ''));

  if (!file || !fs.existsSync(file)) {
    return res.sendStatus(404);
  }

  const m = metaFor(file, false) || (await probe(file, true));
  const tv = req.query.tv === '1';
  const force = req.query.force === '1';
  const p = plan(file, m, tv, force);
  const t = Math.max(0, Number(req.query.t) || 0);

  const sid = crypto.randomBytes(6).toString('hex');
  const dir = path.join(HLS_DIR, sid);

  fs.mkdirSync(dir, { recursive: true });

  const args = baseArgs(file, m, p, t);

  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(dir, 's%05d.ts'),
    path.join(dir, 'index.m3u8')
  );

  console.log(
    `[hls] ${path.basename(file)} | t=${t} tv=${tv} force=${force} -> ` +
      (p.vCopy ? 'vídeo copiado' : 'recodificando vídeo')
  );

  const ff = spawn(FFMPEG, args, { windowsHide: true });
  lowPriority(ff);
  const ses = { ff, dir, last: Date.now(), done: false };

  ff.stderr.on('data', (d) => {
    const msg = d.toString().trim();

    if (msg) console.error('[FFmpeg]', msg);
  });

  ff.on('close', () => { ses.done = true; });

  hlsSessions.set(sid, ses);

  // Responde assim que o primeiro segmento existir.
  const playlist = path.join(dir, 'index.m3u8');
  const t0 = Date.now();

  while (Date.now() - t0 < 30000) {
    try {
      if (/\.ts/.test(fs.readFileSync(playlist, 'utf8'))) break;
    } catch {}

    if (ses.done) break;

    await new Promise((r) => setTimeout(r, 100));
  }

  if (!fs.existsSync(playlist)) {
    endHls(sid);
    return res.sendStatus(500);
  }

  res.json({ url: `/hls/${sid}/index.m3u8` });
});

app.get('/hls/:sid/:name', (req, res) => {
  const ses = hlsSessions.get(req.params.sid);

  if (!ses || !/^[\w.]+$/.test(req.params.name)) {
    return res.sendStatus(404);
  }

  ses.last = Date.now();

  res.set('Cache-Control', 'no-store');

  if (req.params.name.endsWith('.m3u8')) {
    return fs.readFile(path.join(ses.dir, req.params.name), (err, buf) =>
      err ? res.sendStatus(404) : res.type('application/vnd.apple.mpegurl').send(buf));
  }

  res.sendFile(path.join(ses.dir, req.params.name), (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

app.get('/api/hls/stop/:sid', (req, res) => {
  endHls(req.params.sid);
  res.sendStatus(204);
});


app.get(
  '/img/:id',
  sendImage
);

app.get(
  '/sub/:id',
  getSub
);


// ====================================================
// TESTE DO FFMPEG
// ====================================================

function checkFfmpeg() {
  const probe =
    spawn(
      FFMPEG,
      ['-version'],
      {
        windowsHide: true
      }
    );

  probe.on(
    'error',
    (err) => {
      console.warn(
        '[AVISO] FFmpeg não está disponível:',
        err.message
      );
    }
  );

  probe.on(
    'close',
    (code) => {
      if (code === 0) {
        console.log(
          '[OK] FFmpeg encontrado.'
        );
      }
    }
  );
}


// ====================================================
// INICIALIZAÇÃO
// ====================================================

detect();

checkFfmpeg();

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `MeuFlix: http://localhost:${PORT}`
    );

    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
      .map((i) => `http://${i.address}:${PORT}`);

    console.log(
      'Na TV (mesma rede), abra:',
      lan.join(' | ') || 'rede não detectada'
    );

    console.log(
      'Dispositivos:',
      [...roots.values()]
        .map(
          (r) => r.path
        )
        .join(' | ') ||
      'nenhum ainda'
    );

    console.log(
      `Cache de vídeos: ${CACHE_DIR}`
    );
  }
);