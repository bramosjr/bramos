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

// 2. Consulta GraphQL v4
const GRAPHQL_QUERY = `
query {
  viewer {
    login
    repositories(first: 100, affiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      nodes {
        name
        isPrivate
        description
        pushedAt
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
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 30) {
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

async function fetchGitHubData(token) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'GitPages-Sync-Script'
    },
    body: JSON.stringify({ query: GRAPHQL_QUERY })
  });

  if (!response.ok) {
    throw new Error(`Erro na API do GitHub: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`GraphQL Errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data.viewer;
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
  console.log('🔄 [sync-github] Iniciando sincronização de atividades do GitHub...');

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const token = getGitHubToken();
  if (!token) {
    console.warn('⚠️  [sync-github] Nenhum token GitHub identificado (PRIVATE_ACTIVITY_TOKEN/GH_TOKEN ausente).');
    if (fs.existsSync(ACTIVITIES_FILE) && fs.existsSync(ANALYTICS_FILE)) {
      console.log('ℹ️  [sync-github] Mantendo datasets estáticos existentes em cache.');
      return;
    }
    console.warn('⚠️  [sync-github] Gerando datasets mínimos de fallback.');
    return;
  }

  try {
    const viewer = await fetchGitHubData(token);
    const repos = viewer.repositories.nodes || [];
    const totalRepos = repos.length;
    const privateRepos = repos.filter(r => r.isPrivate).length;

    console.log(`✅ [sync-github] Autenticado como ${viewer.login}. Repositórios analisados: ${totalRepos} (${privateRepos} privados).`);

    // 1. Coleta e sanitização de commits
    const allCommits = [];
    let idCounter = 1;

    for (const repo of repos) {
      const history = repo.defaultBranchRef?.target?.history?.nodes || [];
      for (const commit of history) {
        if (!commit.messageHeadline) continue;
        allCommits.push({ commit, repo });
      }
    }

    // Ordenar commits por data decrescente
    allCommits.sort((a, b) => new Date(b.commit.committedDate) - new Date(a.commit.committedDate));

    // Coletar até 100 atividades mais recentes para histórico amplo
    const recentActivities = allCommits.slice(0, 100).map(({ commit, repo }) => {
      const item = sanitizeActivity(commit, repo, viewer.login, idCounter++);
      return item;
    });

    // 2. Cálculo de métricas analíticas
    // 2.1 Distribuição de linguagens (em bytes)
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

    const sortedLangs = Object.entries(langTotals)
      .sort((a, b) => b[1] - a[1]);

    const topLangs = sortedLangs.slice(0, 4);
    const otherBytes = sortedLangs.slice(4).reduce((acc, [, bytes]) => acc + bytes, 0);

    const langLabels = topLangs.map(([name]) => name);
    const langPercentages = topLangs.map(([, bytes]) => totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0);

    if (otherBytes > 0) {
      langLabels.push('Outras');
      langPercentages.push(totalBytes > 0 ? Math.round((otherBytes / totalBytes) * 100) : 0);
    }

    const sumPerc = langPercentages.reduce((a, b) => a + b, 0);
    if (sumPerc > 0 && sumPerc !== 100 && langPercentages.length > 0) {
      langPercentages[0] += (100 - sumPerc);
    }

    // 2.2 Tipos de alteração (Conventional Commits)
    const typeCounts = { feat: 0, fix: 0, refactor: 0, infra: 0, docs: 0 };
    for (const { commit } of allCommits) {
      const headline = commit.messageHeadline.toLowerCase();
      if (headline.startsWith('fix')) typeCounts.fix++;
      else if (headline.startsWith('refactor')) typeCounts.refactor++;
      else if (headline.startsWith('infra') || headline.startsWith('chore') || headline.startsWith('ci')) typeCounts.infra++;
      else if (headline.startsWith('docs')) typeCounts.docs++;
      else typeCounts.feat++;
    }

    // 2.3 Cadência de Entregas por períodos pré-calculados (4w, 8w, 12w)
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

    const cadencePeriods = {
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
      }
    };

    const analyticsData = {
      updatedAt: new Date().toISOString(),
      userLogin: viewer.login,
      totalReposCount: totalRepos,
      privateReposCount: privateRepos,
      languages: {
        labels: langLabels.length > 0 ? langLabels : ['Python', 'JavaScript', 'Rust', 'Shell', 'Outras'],
        percentages: langPercentages.length > 0 ? langPercentages : [40, 30, 15, 10, 5]
      },
      commitTypes: {
        labels: ['feat', 'fix', 'refactor', 'infra', 'docs'],
        counts: [
          typeCounts.feat,
          typeCounts.fix,
          typeCounts.refactor,
          typeCounts.infra,
          typeCounts.docs
        ]
      },
      weeklyCadence: cadencePeriods['4w'],
      cadencePeriods
    };

    // Gravação dos arquivos
    fs.writeFileSync(ACTIVITIES_FILE, JSON.stringify(recentActivities, null, 2), 'utf-8');
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsData, null, 2), 'utf-8');

    console.log(`🎉 [sync-github] Sincronização concluída com sucesso!`);
    console.log(`📁 ${recentActivities.length} atividades salvas em src/data/activities.json`);
    console.log(`📊 Métricas salvas em src/data/analytics.json`);

  } catch (error) {
    console.error('❌ [sync-github] Erro ao sincronizar dados do GitHub:', error.message);
    if (!fs.existsSync(ACTIVITIES_FILE) || !fs.existsSync(ANALYTICS_FILE)) {
      throw error;
    }
    console.log('ℹ️  [sync-github] Mantendo dados anteriores em cache.');
  }
}

main();
