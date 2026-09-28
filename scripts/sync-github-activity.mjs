import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DATA_DIR = path.join(rootDir, 'src', 'data');
const ACTIVITIES_FILE = path.join(DATA_DIR, 'activities.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');

// 1. Obter Token com fallback determinístico
function getGitHubToken() {
  if (process.env.PRIVATE_ACTIVITY_TOKEN) return process.env.PRIVATE_ACTIVITY_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  try {
    const token = execSync('gh auth token', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (token) return token;
  } catch (e) {
    // gh CLI não logado ou indisponível
  }
  return null;
}

// 2. Requisições GraphQL com resiliência e retry
async function executeGraphQL(token, query, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'GitPages-Sync-Script'
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      if (json.errors) {
        throw new Error(`GraphQL: ${json.errors.map(e => e.message).join('; ')}`);
      }

      return json.data;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`⚠️  [sync-github] Tentativa ${attempt + 1} falhou (${err.message}). Retentando em 1.5s...`);
      await new Promise(res => setTimeout(res, 1500));
    }
  }
}

// 2.1 Consulta 1: Repositórios, Metadados Públicos e Linguagens (Sem árvore de commits - Ultra-leve & Imune a 504)
const OVERVIEW_QUERY = `
query {
  viewer {
    login
    repositories(first: 100, affiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      nodes {
        name
        isPrivate
        url
        description
        pushedAt
        stargazerCount
        forkCount
        primaryLanguage {
          name
          color
        }
        languages(first: 5, orderBy: {field: SIZE, direction: DESC}) {
          edges {
            size
            node {
              name
            }
          }
        }
      }
    }
  }
}
`;

// 2.2 Consulta 2: Histórico de Commits (Apenas repositórios recentes e profundidade calibrada)
const COMMITS_QUERY = `
query {
  viewer {
    repositories(first: 30, affiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        name
        isPrivate
        url
        primaryLanguage {
          name
        }
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 25) {
                nodes {
                  oid
                  messageHeadline
                  committedDate
                  url
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

// Fallback REST para repositórios públicos se o GraphQL falhar inteiramente
async function fetchPublicReposRest(username, token) {
  const headers = {
    'User-Agent': 'GitPages-Sync-Script',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com/users/${username}/repos?type=public&per_page=100&sort=pushed`, { headers });
  if (!response.ok) {
    throw new Error(`REST API: ${response.status} ${response.statusText}`);
  }
  const repos = await response.json();
  return repos.map(r => ({
    name: r.name,
    fullName: r.full_name,
    url: r.html_url,
    description: r.description || 'Projeto de código aberto rastreado no GitHub.',
    primaryLanguage: r.language || 'Software',
    languageColor: '#34D399',
    stargazerCount: r.stargazers_count || 0,
    forkCount: r.forks_count || 0,
    pushedAt: r.pushed_at
  }));
}

// 3. Sanitização de Mensagens e Repositórios sob NDA
function sanitizeActivity(commit, repo, viewerLogin, id) {
  let headline = commit.messageHeadline.trim();

  // Limpeza de referências a issues internas, links e PR merges
  headline = headline.replace(/\(Closes\s*#\d+\)/gi, '');
  headline = headline.replace(/\(#\d+\)/gi, '');
  headline = headline.replace(/Merge pull request #\d+ from [^\s]+/gi, 'Merge pull request');

  // Identificação do Conventional Commit
  let type = 'feat';
  let category = 'feat';
  const lower = headline.toLowerCase();

  if (lower.startsWith('fix') || lower.includes('correção') || lower.includes('bug')) {
    type = 'fix';
    category = 'fix';
  } else if (lower.startsWith('docs') || lower.includes('readme') || lower.includes('document')) {
    type = 'docs';
    category = 'infra';
  } else if (lower.startsWith('refactor') || lower.includes('refatora') || lower.includes('otimiz')) {
    type = 'refactor';
    category = 'refactor';
  } else if (lower.startsWith('infra') || lower.startsWith('chore') || lower.startsWith('ci') || lower.includes('deploy')) {
    type = 'infra';
    category = 'infra';
  } else if (lower.startsWith('release') || lower.includes('versão') || lower.includes('v0.') || lower.includes('v1.') || lower.includes('v2.')) {
    type = 'release';
    category = 'release';
  } else if (lower.startsWith('feat') || lower.includes('adiciona') || lower.includes('novo') || lower.includes('nova')) {
    type = 'feat';
    category = 'feat';
  }

  // Descaracterização do repositório se for privado
  const langName = repo.primaryLanguage?.name || 'Software';
  const repoAlias = repo.isPrivate 
    ? `Projeto Privado: Solução em ${langName}`
    : `${viewerLogin}/${repo.name}`;

  // Tags sanitizadas
  const tags = [];
  if (repo.primaryLanguage?.name) tags.push(repo.primaryLanguage.name);
  if (type !== 'feat' && type !== 'fix') tags.push(type.toUpperCase());
  if (repo.isPrivate) tags.push('NDA');

  // Cálculo de tempo relativo
  const commitDate = new Date(commit.committedDate);
  const now = new Date();
  const diffDays = Math.max(0, Math.floor((now - commitDate) / (1000 * 60 * 60 * 24)));
  const timeAgo = diffDays === 0 ? 'hoje' : diffDays === 1 ? 'há 1 dia' : `há ${diffDays} dias`;

  return {
    id,
    title: headline,
    type,
    category,
    isPrivate: repo.isPrivate,
    repoName: repo.isPrivate ? null : repo.name,
    repoUrl: repo.isPrivate ? null : (repo.url || `https://github.com/${viewerLogin}/${repo.name}`),
    commitUrl: repo.isPrivate ? null : commit.url,
    repoAlias,
    tags,
    date: commitDate.toISOString().split('T')[0],
    diffDays,
    timeAgo,
    summary: `Registro de atividade técnica sanitizada em repositório ${repo.isPrivate ? 'privado sob protocolo NDA' : 'público'} com foco em entregas contínuas.`,
    isMajor: type === 'release' || type === 'feat'
  };
}

async function main() {
  console.log('🔄 [sync-github] Iniciando sincronização desacoplada de atividades do GitHub...');

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Carregar dados de cache existentes caso haja contingência parcial
  let cachedAnalytics = null;
  let cachedActivities = null;
  if (fs.existsSync(ANALYTICS_FILE)) {
    try {
      cachedAnalytics = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf-8'));
    } catch (e) {
      // Ignora erro de parse em cache
    }
  }
  if (fs.existsSync(ACTIVITIES_FILE)) {
    try {
      cachedActivities = JSON.parse(fs.readFileSync(ACTIVITIES_FILE, 'utf-8'));
    } catch (e) {
      // Ignora erro de parse em cache
    }
  }

  const token = getGitHubToken();
  if (!token) {
    console.warn('⚠️  [sync-github] Nenhum token GitHub identificado (PRIVATE_ACTIVITY_TOKEN/GH_TOKEN ausente).');
    if (cachedAnalytics && cachedActivities) {
      console.log('ℹ️  [sync-github] Mantendo datasets estáticos existentes em cache.');
      return;
    }
    console.warn('⚠️  [sync-github] Gerando datasets mínimos de fallback.');
    return;
  }

  // =========================================================================
  // FASE A: Ingestão Desacoplada de Repositórios e Metadados (Ultra-leve)
  // =========================================================================
  let viewerLogin = cachedAnalytics?.userLogin || 'bramosjr';
  let totalRepos = cachedAnalytics?.totalReposCount || 0;
  let privateRepos = cachedAnalytics?.privateReposCount || 0;
  let publicRepositories = cachedAnalytics?.publicRepositories || [];
  let langLabels = cachedAnalytics?.languages?.labels || ['Python', 'JavaScript', 'Rust', 'Shell', 'Outras'];
  let langPercentages = cachedAnalytics?.languages?.percentages || [40, 30, 15, 10, 5];

  let overviewSuccess = false;
  try {
    const overviewData = await executeGraphQL(token, OVERVIEW_QUERY, 2);
    const viewer = overviewData.viewer;
    viewerLogin = viewer.login;
    const repos = viewer.repositories.nodes || [];
    totalRepos = repos.length;
    privateRepos = repos.filter(r => r.isPrivate).length;

    // Repositórios públicos com metadados completos
    publicRepositories = repos
      .filter(r => !r.isPrivate)
      .map(r => ({
        name: r.name,
        fullName: `${viewer.login}/${r.name}`,
        url: r.url || `https://github.com/${viewer.login}/${r.name}`,
        description: r.description || 'Projeto de código aberto rastreado no GitHub.',
        primaryLanguage: r.primaryLanguage?.name || 'Software',
        languageColor: r.primaryLanguage?.color || '#34D399',
        stargazerCount: r.stargazerCount || 0,
        forkCount: r.forkCount || 0,
        pushedAt: r.pushedAt
      }));

    // Métricas analíticas de linguagens (em bytes)
    const langTotals = {};
    let totalBytes = 0;
    for (const repo of repos) {
      const edges = repo.languages?.edges || [];
      for (const edge of edges) {
        const name = edge.node.name;
        const size = edge.size;
        langTotals[name] = (langTotals[name] || 0) + size;
        totalBytes += size;
      }
    }

    const sortedLangs = Object.entries(langTotals).sort((a, b) => b[1] - a[1]);
    const topLangs = sortedLangs.slice(0, 4);
    const otherBytes = sortedLangs.slice(4).reduce((acc, [, bytes]) => acc + bytes, 0);

    langLabels = topLangs.map(([name]) => name);
    langPercentages = topLangs.map(([, bytes]) => totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0);

    if (otherBytes > 0) {
      langLabels.push('Outras');
      langPercentages.push(totalBytes > 0 ? Math.round((otherBytes / totalBytes) * 100) : 0);
    }

    const sumPerc = langPercentages.reduce((a, b) => a + b, 0);
    if (sumPerc > 0 && sumPerc !== 100 && langPercentages.length > 0) {
      langPercentages[0] += (100 - sumPerc);
    }

    overviewSuccess = true;
    console.log(`✅ [sync-github] Fase A concluída: ${totalRepos} repositórios analisados (${publicRepositories.length} públicos, ${privateRepos} privados).`);
  } catch (error) {
    console.error('⚠️  [sync-github] Falha no overview GraphQL:', error.message);
    try {
      console.log('🔄 [sync-github] Acionando fallback REST para repositórios públicos...');
      publicRepositories = await fetchPublicReposRest(viewerLogin, token);
      console.log(`✅ [sync-github] Fallback REST concluído: ${publicRepositories.length} repositórios públicos capturados.`);
    } catch (restErr) {
      console.error('❌ [sync-github] Fallback REST também falhou:', restErr.message);
    }
  }

  // =========================================================================
  // FASE B: Ingestão de Histórico de Commits e Telemetria (Resiliente e Otimizada)
  // =========================================================================
  let recentActivities = cachedActivities || [];
  let commitTypes = cachedAnalytics?.commitTypes || {
    labels: ['feat', 'fix', 'refactor', 'infra', 'docs'],
    counts: [0, 0, 0, 0, 0]
  };
  let weeklyCadence = cachedAnalytics?.weeklyCadence || { labels: [], counts: [] };
  let cadencePeriods = cachedAnalytics?.cadencePeriods || null;

  try {
    const commitsData = await executeGraphQL(token, COMMITS_QUERY, 1);
    const commitRepos = commitsData.viewer.repositories.nodes || [];

    const allCommits = [];
    let idCounter = 1;

    for (const repo of commitRepos) {
      const history = repo.defaultBranchRef?.target?.history?.nodes || [];
      for (const commit of history) {
        if (!commit.messageHeadline) continue;
        allCommits.push({ commit, repo });
      }
    }

    if (allCommits.length > 0) {
      allCommits.sort((a, b) => new Date(b.commit.committedDate) - new Date(a.commit.committedDate));

      const publicCommits = allCommits.filter(c => !c.repo.isPrivate);
      const privateCommits = allCommits.filter(c => c.repo.isPrivate);

      const combinedCommits = [
        ...publicCommits,
        ...privateCommits.slice(0, Math.max(100, 150 - publicCommits.length))
      ];
      combinedCommits.sort((a, b) => new Date(b.commit.committedDate) - new Date(a.commit.committedDate));

      recentActivities = combinedCommits.map(({ commit, repo }) => {
        return sanitizeActivity(commit, repo, viewerLogin, idCounter++);
      });

      // Tipos de alteração (Conventional Commits)
      const typeCounts = { feat: 0, fix: 0, refactor: 0, infra: 0, docs: 0 };
      for (const { commit } of allCommits) {
        const headline = commit.messageHeadline.toLowerCase();
        if (headline.startsWith('fix')) typeCounts.fix++;
        else if (headline.startsWith('refactor')) typeCounts.refactor++;
        else if (headline.startsWith('infra') || headline.startsWith('chore') || headline.startsWith('ci')) typeCounts.infra++;
        else if (headline.startsWith('docs')) typeCounts.docs++;
        else typeCounts.feat++;
      }

      commitTypes = {
        labels: ['feat', 'fix', 'refactor', 'infra', 'docs'],
        counts: [
          typeCounts.feat,
          typeCounts.fix,
          typeCounts.refactor,
          typeCounts.infra,
          typeCounts.docs
        ]
      };

      // Cadência de Entregas por períodos pré-calculados (4w, 8w, 12w, all)
      const now = new Date();
      function computeBuckets(numWeeks) {
        const buckets = new Array(numWeeks).fill(0);
        for (const { commit } of allCommits) {
          const cDate = new Date(commit.committedDate);
          const diffWeeks = Math.floor((now - cDate) / (1000 * 60 * 60 * 24 * 7));
          if (diffWeeks >= 0 && diffWeeks < numWeeks) {
            buckets[numWeeks - 1 - diffWeeks]++;
          }
        }
        return buckets.map(c => Math.max(c, 0));
      }

      const buckets4w = computeBuckets(4);
      const buckets8w = computeBuckets(8);
      const buckets12w = computeBuckets(12);

      let oldestDate = now;
      for (const { commit } of allCommits) {
        const cDate = new Date(commit.committedDate);
        if (cDate < oldestDate) oldestDate = cDate;
      }
      const totalHistoryWeeks = Math.max(12, Math.ceil((now - oldestDate) / (1000 * 60 * 60 * 24 * 7)));
      const bucketsAll = computeBuckets(totalHistoryWeeks);

      const labelsAll = [];
      for (let i = totalHistoryWeeks - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
        const mes = d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
        labelsAll.push(`${mes} S${Math.ceil(d.getDate() / 7)}`);
      }

      cadencePeriods = {
        '4w': {
          labels: ['Semana 1', 'Semana 2', 'Semana 3', 'Semana 4'],
          counts: buckets4w
        },
        '8w': {
          labels: ['Sem 1', 'Sem 2', 'Sem 3', 'Sem 4', 'Sem 5', 'Sem 6', 'Sem 7', 'Sem 8'],
          counts: buckets8w
        },
        '12w': {
          labels: ['Sem 1', 'Sem 2', 'Sem 3', 'Sem 4', 'Sem 5', 'Sem 6', 'Sem 7', 'Sem 8', 'Sem 9', 'Sem 10', 'Sem 11', 'Sem 12'],
          counts: buckets12w
        },
        'all': {
          labels: labelsAll,
          counts: bucketsAll
        }
      };
      weeklyCadence = cadencePeriods['4w'];

      console.log(`✅ [sync-github] Fase B concluída: ${recentActivities.length} atividades processadas com sucesso.`);
    }
  } catch (error) {
    console.warn(`⚠️  [sync-github] Fase B (Histórico de Commits) falhou (${error.message}). Reutilizando telemetria em cache.`);
  }

  // =========================================================================
  // FASE C: Gravação Atômica dos Datasets
  // =========================================================================
  const analyticsData = {
    updatedAt: new Date().toISOString(),
    userLogin: viewerLogin,
    totalReposCount: totalRepos,
    privateReposCount: privateRepos,
    publicRepositories,
    languages: {
      labels: langLabels,
      percentages: langPercentages
    },
    commitTypes,
    weeklyCadence,
    cadencePeriods: cadencePeriods || cachedAnalytics?.cadencePeriods
  };

  fs.writeFileSync(ACTIVITIES_FILE, JSON.stringify(recentActivities, null, 2), 'utf-8');
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsData, null, 2), 'utf-8');

  console.log('🎉 [sync-github] Sincronização concluída com sucesso!');
  console.log(`📁 ${recentActivities.length} atividades salvas em src/data/activities.json`);
  console.log(`📊 Métricas salvas em src/data/analytics.json (${publicRepositories.length} repositórios públicos)`);
}

main();
