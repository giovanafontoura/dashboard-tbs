export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado' });
  }

  try {
    const contacts = await fetchAllContacts(token);

    const waByTerm     = {};
    const emByTerm     = {};
    const byDay        = {};
    const byDayByTerm  = {};
    const waIds        = new Set();
    const emIds        = new Set();
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
          byDay[day] = byDay[day] || { wa:0, em:0 };
          byDay[day].wa++;
          byDayByTerm[day] = byDayByTerm[day] || { wa:{}, em:{} };
          byDayByTerm[day].wa[term] = (byDayByTerm[day].wa[term] || 0) + 1;
        }
      }
      if (isEM) {
        emByTerm[term] = (emByTerm[term] || 0) + 1;
        if (day) {
          byDay[day] = byDay[day] || { wa:0, em:0 };
          byDay[day].em++;
          byDayByTerm[day] = byDayByTerm[day] || { wa:{}, em:{} };
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

    const totWA = Object.values(waByTerm).reduce((a,b) => a+b, 0);
    const totEM = Object.values(emByTerm).reduce((a,b) => a+b, 0);

    return res.json({
      waByTerm, emByTerm, byDay, byDayByTerm, dealsByTerm,
      totals: { wa: totWA, em: totEM, total: totWA+totEM, deals: dealsTotal },
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hsGet(url, options) {
  const resp = await fetch(url, options);
  if (resp.status === 429) {
    await sleep(2000);
    return fetch(url, options);
  }
  return resp;
}

async function fetchAllContacts(token) {
  const URL = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  const H   = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const all = [];
  let after;
  do {
    if (after) await sleep(300);
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'inscrito_tbs_2026', operator: 'EQ', value: 'Sim' }] }],
      properties: ['utm_term_tbs','fonte__tbs_','detalhamento_1_da_fonte__tbs_','tbs_2026__data_de_inscricao'],
      limit: 200,
      ...(after && { after })
    };
    const resp = await hsGet(URL, { method:'POST', headers:H, body:JSON.stringify(body) });
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
    if (after) await sleep(300);
    const body = {
      filterGroups: [{ filters: [
        { propertyName:'pipeline',  operator:'EQ', value:'904543067' },
        { propertyName:'dealstage', operator:'EQ', value:'1372708683' }
      ]}],
      properties: ['hs_object_id'],
      limit: 100,
      ...(after && { after })
    };
    const resp = await hsGet('https://api.hubapi.com/crm/v3/objects/deals/search',
                             { method:'POST', headers:H, body:JSON.stringify(body) });
    if (!resp.ok) throw new Error(`HubSpot Deals ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    for (const d of (data.results || [])) dealIds.push(d.id);
    after = data.paging?.next?.after ?? null;
  } while (after);

  if (dealIds.length === 0) return { total:0, byTerm:{} };
  console.log(`[deals] ${dealIds.length} deals encontrados`);

  // 2. Associações deal → contato
  let total = 0;
  const byTerm = {};

  for (let i = 0; i < dealIds.length; i += 100) {
    if (i > 0) await sleep(300);
    const batch = dealIds.slice(i, i+100);
    const resp = await hsGet(
      'https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/read',
      { method:'POST', headers:H, body:JSON.stringify({ inputs: batch.map(id => ({ id:String(id) })) }) }
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
