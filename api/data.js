export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado nas variáveis de ambiente do Vercel' });
  }

  try {
    const { contacts, filterUsed } = await fetchAllContacts(token);
    console.log(`[handler] ${contacts.length} contatos via filtro: ${filterUsed}`);

    const waByTerm    = {};
    const emByTerm    = {};
    const byDay       = {};
    const byDayByTerm = {};
    const waIds       = new Set();
    const emIds       = new Set();
    const contactToTerm = {};

    for (const { id, properties: p } of contacts) {
      const fonte = (p.fonte__tbs_ || '').toLowerCase();
      const det   = (p.detalhamento_1_da_fonte__tbs_ || '').toLowerCase();
      const isWA  = fonte === 'organic social' && det === 'whatsapp';
      const isEM  = fonte === 'email marketing';
      if (!isWA && !isEM) continue;

      const sid  = String(id);
      const term = p.utm_term_tbs || 'sem_term';
      const day  = p.tbs_2026__data_de_inscricao
                     ? p.tbs_2026__data_de_inscricao.slice(0, 10) : null;

      if (isWA) waIds.add(sid);
      if (isEM) emIds.add(sid);
      contactToTerm[sid] = term;

      if (isWA) {
        waByTerm[term] = (waByTerm[term] || 0) + 1;
        if (day) {
          byDay[day] = byDay[day] || { wa: 0, em: 0 };
          byDay[day].wa++;
          byDayByTerm[day] = byDayByTerm[day] || { wa: {}, em: {} };
          byDayByTerm[day].wa[term] = (byDayByTerm[day].wa[term] || 0) + 1;
        }
      }
      if (isEM) {
        emByTerm[term] = (emByTerm[term] || 0) + 1;
        if (day) {
          byDay[day] = byDay[day] || { wa: 0, em: 0 };
          byDay[day].em++;
          byDayByTerm[day] = byDayByTerm[day] || { wa: {}, em: {} };
          byDayByTerm[day].em[term] = (byDayByTerm[day].em[term] || 0) + 1;
        }
      }
    }

    const allContactIds = new Set([...waIds, ...emIds]);

    let dealsTotal = 0;
    let dealsByTerm = {};
    try {
      ({ total: dealsTotal, byTerm: dealsByTerm } =
        await fetchDealsCount(token, allContactIds, contactToTerm));
    } catch (e) {
      console.error('[deals] falhou (non-fatal):', e.message);
    }

    const totWA = Object.values(waByTerm).reduce((a, b) => a + b, 0);
    const totEM = Object.values(emByTerm).reduce((a, b) => a + b, 0);

    return res.json({
      waByTerm, emByTerm, byDay, byDayByTerm, dealsByTerm,
      totals: { wa: totWA, em: totEM, total: totWA + totEM, deals: dealsTotal },
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Erro ao buscar dados HubSpot:', err);
    return res.status(500).json({ error: err.message });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry inteligente: 429 → 2s; 5xx → backoff; 4xx fixo → sem retry
async function fetchHS(url, options, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const resp = await fetch(url, options);
    if (resp.ok) return resp;
    if (resp.status !== 429 && resp.status < 500) return resp;
    if (i === retries) return resp;
    const wait = resp.status === 429 ? 2000 : 1000 * (i + 1);
    console.warn(`[fetchHS] ${resp.status} → retry ${i + 1}/${retries} em ${wait}ms`);
    await sleep(wait);
  }
}

// Filtros em cascata (do mais preciso para o mais amplo).
// Pula se 400 (propriedade inválida) ou se retornar 0 contatos WA/EM.
async function fetchAllContacts(token) {
  const ENDPOINT = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  const HEADERS  = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const FILTERS = [
    // 1. Por fonte diretamente — WA (det=whatsapp) ou EM, com data TBS 2026
    {
      label: 'fonte+data',
      filterGroups: [
        { filters: [
          { propertyName: 'detalhamento_1_da_fonte__tbs_', operator: 'CONTAINS_TOKEN', value: 'whatsapp' },
          { propertyName: 'tbs_2026__data_de_inscricao',   operator: 'IS_KNOWN' }
        ]},
        { filters: [
          { propertyName: 'fonte__tbs_', operator: 'CONTAINS_TOKEN', value: 'email' },
          { propertyName: 'tbs_2026__data_de_inscricao',  operator: 'IS_KNOWN' }
        ]}
      ]
    },
    // 2. Apenas pela data de inscrição TBS 2026 (isWA/isEM filtra na memória)
    {
      label: 'data_inscricao',
      filterGroups: [
        { filters: [{ propertyName: 'tbs_2026__data_de_inscricao', operator: 'IS_KNOWN' }] }
      ]
    },
    // 3. Fallback: campo original (pode ter mudado de tipo/valor)
    {
      label: 'inscrito_sim',
      filterGroups: [
        { filters: [{ propertyName: 'inscrito_tbs_2026', operator: 'EQ', value: 'Sim' }] }
      ]
    },
  ];

  for (const { label, filterGroups } of FILTERS) {
    let all;
    try {
      all = await _paginate(ENDPOINT, HEADERS, filterGroups);
    } catch (e) {
      if (e.message.includes(' 400')) {
        console.warn(`[contacts] filtro "${label}" → 400, próximo`);
        continue;
      }
      throw e;
    }

    const qualified = all.filter(({ properties: p }) => {
      const fonte = (p.fonte__tbs_ || '').toLowerCase();
      const det   = (p.detalhamento_1_da_fonte__tbs_ || '').toLowerCase();
      return (fonte === 'organic social' && det === 'whatsapp') || fonte === 'email marketing';
    });

    if (qualified.length === 0) {
      console.warn(`[contacts] filtro "${label}" → ${all.length} contatos mas 0 WA/EM, próximo`);
      continue;
    }

    console.log(`[contacts] filtro "${label}" → ${all.length} total, ${qualified.length} WA/EM`);
    return { contacts: all, filterUsed: label };
  }

  throw new Error('Nenhum filtro retornou contatos WA/EM');
}

async function _paginate(endpoint, headers, filterGroups) {
  const all = [];
  let after;
  do {
    if (after) await sleep(300);
    const resp = await fetchHS(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filterGroups,
        properties: ['utm_term_tbs', 'fonte__tbs_', 'detalhamento_1_da_fonte__tbs_', 'tbs_2026__data_de_inscricao'],
        limit: 200,
        ...(after && { after })
      })
    });
    if (!resp.ok) throw new Error(`HubSpot Contacts ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    all.push(...(data.results || []));
    after = data.paging?.next?.after ?? null;
  } while (after);
  return all;
}

async function fetchDealsCount(token, allContactIds, contactToTerm) {
  const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1. Deal IDs em Negócio Fechado / The Best School
  const dealIds = [];
  let after;
  do {
    if (after) await sleep(200);
    const resp = await fetchHS('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        filterGroups: [{ filters: [
          { propertyName: 'pipeline',  operator: 'EQ', value: '904543067' },
          { propertyName: 'dealstage', operator: 'EQ', value: '1372708683' }
        ]}],
        properties: ['hs_object_id'],
        limit: 100,
        ...(after && { after })
      })
    });
    if (!resp.ok) throw new Error(`HubSpot Deals ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    for (const d of (data.results || [])) dealIds.push(d.id);
    after = data.paging?.next?.after ?? null;
  } while (after);

  if (dealIds.length === 0) return { total: 0, byTerm: {} };
  console.log(`[deals] ${dealIds.length} deals encontrados`);

  // 2. Associações deal → contato, cruza com contatos WA/EM já buscados
  let total = 0;
  const byTerm = {};

  for (let i = 0; i < dealIds.length; i += 100) {
    if (i > 0) await sleep(200);
    const batch = dealIds.slice(i, i + 100);
    const resp = await fetchHS(
      'https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/read',
      { method: 'POST', headers: H, body: JSON.stringify({ inputs: batch.map(id => ({ id: String(id) })) }) }
    );
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const result of (data.results || [])) {
      const matchingCids = (result.to || [])
        .map(t => String(t.toObjectId))
        .filter(cid => allContactIds.has(cid));
      if (!matchingCids.length) continue;
      total++;
      const terms = new Set(matchingCids.map(cid => contactToTerm[cid] || 'sem_term'));
      for (const t of terms) byTerm[t] = (byTerm[t] || 0) + 1;
    }
  }

  console.log(`[deals] ${total} qualificados`);
  return { total, byTerm };
}
