export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado nas variáveis de ambiente do Vercel' });
  }

  try {
    // Contacts é crítico — se falhar, retorna erro para o frontend usar DEMO
    const contacts = await fetchAllContacts(token);

    // Deals é não-fatal — se falhar, continua sem dados de compras
    let buyersResult = { total: 0, byTerm: {} };
    try {
      buyersResult = await fetchDealsWithTerms(token);
    } catch (dealsErr) {
      console.error('Deals fetch failed (non-fatal):', dealsErr.message);
    }

    const waByTerm    = {};
    const emByTerm    = {};
    const byDay       = {};
    const byDayByTerm = {};

    for (const { properties: p } of contacts) {
      const fonte = (p.fonte__tbs_ || '').toLowerCase();
      const det   = (p.detalhamento_1_da_fonte__tbs_ || '').toLowerCase();
      const isWA  = fonte === 'organic social' && det === 'whatsapp';
      const isEM  = fonte === 'email marketing';

      if (!isWA && !isEM) continue;

      const term = p.utm_term_tbs || 'sem_term';
      const day  = p.tbs_2026__data_de_inscricao
                     ? p.tbs_2026__data_de_inscricao.slice(0, 10)
                     : null;

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

    const totWA = Object.values(waByTerm).reduce((a, b) => a + b, 0);
    const totEM = Object.values(emByTerm).reduce((a, b) => a + b, 0);

    return res.json({
      waByTerm,
      emByTerm,
      byDay,
      byDayByTerm,
      dealsByTerm: buyersResult.byTerm,
      totals: {
        wa:    totWA,
        em:    totEM,
        total: totWA + totEM,
        deals: buyersResult.total
      },
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Erro ao buscar dados HubSpot:', err);
    return res.status(500).json({ error: err.message });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry automático em 429 (rate limit) e 5xx do HubSpot
async function fetchHS(url, options, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    const resp = await fetch(url, options);
    if (resp.ok) return resp;
    if (resp.status !== 429 && resp.status < 500) return resp; // 4xx fixo: não retenta
    if (i === retries) return resp;                             // esgotou tentativas
    const wait = resp.status === 429 ? 2000 : 1500 * (i + 1); // 429 → 2s; 5xx → backoff
    console.warn(`[fetchHS] ${resp.status} → retry ${i + 1}/${retries} em ${wait}ms`);
    await sleep(wait);
  }
}

// Contatos qualificados: fonte WA ou Email OU utm_term = whatsapp/email/hs_mail/hs_automation
function qualifyContact(p) {
  if (!p) return false;
  const fonte = (p.fonte__tbs_ || '').toLowerCase();
  const det   = (p.detalhamento_1_da_fonte__tbs_ || '').toLowerCase();
  const term  = (p.utm_term_tbs || '').toLowerCase();
  if (fonte === 'organic social' && det === 'whatsapp') return true;
  if (fonte === 'email marketing') return true;
  if (['whatsapp', 'email', 'hs_mail', 'hs_automation'].includes(term)) return true;
  return false;
}

async function fetchAllContacts(token) {
  const ENDPOINT = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  const HEADERS  = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const all = [];
  let after;
  do {
    if (after) await sleep(500);
    const resp = await fetchHS(ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'tbs_2026__data_de_inscricao', operator: 'IS_KNOWN' }] }],
        properties: ['utm_term_tbs', 'fonte__tbs_', 'detalhamento_1_da_fonte__tbs_', 'tbs_2026__data_de_inscricao'],
        limit: 100,
        ...(after && { after })
      })
    });
    if (!resp.ok) throw new Error(`HubSpot Contacts ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    all.push(...(data.results || []));
    after = data.paging?.next?.after;
  } while (after);
  return all;
}

async function fetchDealsWithTerms(token) {
  const HEADERS = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1. Todos os deals na etapa Negócio Fechado
  console.log('[deals] buscando deal IDs...');
  const dealIds = [];
  let after;
  do {
    if (after) await sleep(150);
    const resp = await fetchHS('https://api.hubapi.com/crm/v3/objects/deals/search', {
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

  console.log(`[deals] ${dealIds.length} deals encontrados`);
  if (dealIds.length === 0) return { total: 0, byTerm: {} };

  // 2. Contatos associados a cada deal
  const dealToContacts = {};
  const allAssocCids = new Set();

  for (let i = 0; i < dealIds.length; i += 100) {
    if (i > 0) await sleep(500);
    const batch = dealIds.slice(i, i + 100);
    const resp = await fetchHS('https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/read', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ inputs: batch.map(id => ({ id: String(id) })) })
    });
    if (!resp.ok) { console.error(`[assoc] erro ${resp.status}`); continue; }
    const data = await resp.json();
    for (const result of (data.results || [])) {
      const cids = (result.to || []).map(t => String(t.toObjectId));
      dealToContacts[String(result.from?.id || '')] = cids;
      cids.forEach(cid => allAssocCids.add(cid));
    }
  }

  console.log(`[deals] ${allAssocCids.size} contatos associados`);

  // 3. Propriedades dos contatos associados (batch read)
  const contactProps = {};
  const cidList = [...allAssocCids];

  for (let i = 0; i < cidList.length; i += 100) {
    if (i > 0) await sleep(500);
    const batch = cidList.slice(i, i + 100);
    const resp = await fetchHS('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        inputs: batch.map(id => ({ id })),
        idProperty: 'hs_object_id',
        properties: ['utm_term_tbs', 'fonte__tbs_', 'detalhamento_1_da_fonte__tbs_']
      })
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const c of (data.results || [])) {
      contactProps[String(c.id)] = c.properties;
    }
  }

  // 4. Conta deals cujos contatos associados se qualificam
  let total = 0;
  const byTerm = {};

  for (const [, cids] of Object.entries(dealToContacts)) {
    const matchingCids = cids.filter(cid => qualifyContact(contactProps[cid]));
    if (matchingCids.length === 0) continue;

    total++;

    const terms = new Set(matchingCids.map(cid => contactProps[cid]?.utm_term_tbs || 'sem_term'));
    for (const term of terms) {
      byTerm[term] = (byTerm[term] || 0) + 1;
    }
  }

  return { total, byTerm };
}
