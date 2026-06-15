export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado nas variáveis de ambiente do Vercel' });
  }

  try {
    const contacts = await fetchAllContacts(token);

    const waByTerm = {};
    const emByTerm = {};
    const byDay = {};
    const byDayByTerm = {};
    const waIds = new Set();
    const emIds = new Set();

    for (const { id, properties: p } of contacts) {
      const fonte = (p.fonte__tbs_ || '').toLowerCase();
      const det   = (p.detalhamento_1_da_fonte__tbs_ || '').toLowerCase();
      const isWA  = fonte === 'organic social' && det === 'whatsapp';
      const isEM  = fonte === 'email marketing';

      if (!isWA && !isEM) continue;

      if (isWA) waIds.add(String(id));
      if (isEM) emIds.add(String(id));

      const waTerm = p.utm_term_tbs || 'sem_term';
      const emTerm = p.detalhamento_1_da_fonte__tbs_ || 'sem_term';
      const day    = p.tbs_2026__data_de_inscricao
                       ? p.tbs_2026__data_de_inscricao.slice(0, 10)
                       : null;

      if (isWA) {
        waByTerm[waTerm] = (waByTerm[waTerm] || 0) + 1;
        if (day) {
          byDay[day] = byDay[day] || { wa: 0, em: 0 };
          byDay[day].wa++;
          byDayByTerm[day] = byDayByTerm[day] || { wa: {}, em: {} };
          byDayByTerm[day].wa[waTerm] = (byDayByTerm[day].wa[waTerm] || 0) + 1;
        }
      }
      if (isEM) {
        emByTerm[emTerm] = (emByTerm[emTerm] || 0) + 1;
        if (day) {
          byDay[day] = byDay[day] || { wa: 0, em: 0 };
          byDay[day].em++;
          byDayByTerm[day] = byDayByTerm[day] || { wa: {}, em: {} };
          byDayByTerm[day].em[emTerm] = (byDayByTerm[day].em[emTerm] || 0) + 1;
        }
      }
    }

    const dealsTotal = await fetchDealsCount(token, waIds, emIds);

    const totWA = Object.values(waByTerm).reduce((a, b) => a + b, 0);
    const totEM = Object.values(emByTerm).reduce((a, b) => a + b, 0);

    return res.json({
      waByTerm,
      emByTerm,
      byDay,
      byDayByTerm,
      totals: {
        wa:    totWA,
        em:    totEM,
        total: totWA + totEM,
        deals: dealsTotal
      },
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Erro ao buscar dados HubSpot:', err);
    return res.status(500).json({ error: err.message });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllContacts(token) {
  const ENDPOINT = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  const HEADERS  = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const all = [];
  let after;

  do {
    if (after) await sleep(300);
    const body = {
      filterGroups: [{
        filters: [{
          propertyName: 'inscrito_tbs_2026',
          operator: 'EQ',
          value: 'Sim'
        }]
      }],
      properties: [
        'utm_term_tbs',
        'fonte__tbs_',
        'detalhamento_1_da_fonte__tbs_',
        'tbs_2026__data_de_inscricao'
      ],
      limit: 100,
      ...(after && { after })
    };

    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HubSpot API ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    all.push(...(data.results || []));
    after = data.paging?.next?.after;

  } while (after);

  return all;
}

async function fetchDealsCount(token, waIds, emIds) {
  const allContactIds = new Set([...waIds, ...emIds]);
  const HEADERS = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // Step 1: fetch all deal IDs in pipeline + stage
  const dealIds = [];
  let after;
  do {
    if (after) await sleep(300);
    const resp = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers: HEADERS,
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
    after = data.paging?.next?.after;
  } while (after);

  // Step 2: for each batch of deals, check if any associated contact is WA/EM
  let count = 0;
  for (let i = 0; i < dealIds.length; i += 100) {
    if (i > 0) await sleep(300);
    const batch = dealIds.slice(i, i + 100);
    const resp = await fetch('https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/read', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ inputs: batch.map(id => ({ id: String(id) })) })
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const result of (data.results || [])) {
      const cids = (result.to || []).map(t => String(t.toObjectId));
      if (cids.some(cid => allContactIds.has(cid))) count++;
    }
  }

  return count;
}
