export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado nas variáveis de ambiente do Vercel' });
  }

  try {
    // Busca paralela: inscritos + compradores
    const [contacts, buyersResult] = await Promise.all([
      fetchAllContacts(token),
      fetchBuyersByTerm(token)
    ]);

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

async function fetchAllContacts(token) {
  const ENDPOINT = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  const HEADERS  = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const all = [];
  let after;
  do {
    if (after) await sleep(300);
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'inscrito_tbs_2026', operator: 'EQ', value: 'Sim' }] }],
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

// Busca compradores diretamente pelo campo tbschool__data_do_pagamento
// Não depende de inscrito_tbs_2026 nem de associações de deals
async function fetchBuyersByTerm(token) {
  const ENDPOINT = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  const HEADERS  = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const byTerm = {};
  let total = 0;
  let after;

  do {
    if (after) await sleep(300);
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        filterGroups: [
          // WA: Organic Social + WhatsApp + data_do_pagamento preenchida
          {
            filters: [
              { propertyName: 'tbschool__data_do_pagamento', operator: 'HAS_PROPERTY' },
              { propertyName: 'fonte__tbs_',                 operator: 'EQ', value: 'Organic Social' },
              { propertyName: 'detalhamento_1_da_fonte__tbs_', operator: 'EQ', value: 'WhatsApp' }
            ]
          },
          // Email: Email Marketing + data_do_pagamento preenchida
          {
            filters: [
              { propertyName: 'tbschool__data_do_pagamento', operator: 'HAS_PROPERTY' },
              { propertyName: 'fonte__tbs_',                 operator: 'EQ', value: 'Email Marketing' }
            ]
          }
        ],
        properties: ['utm_term_tbs'],
        limit: 100,
        ...(after && { after })
      })
    });
    if (!resp.ok) throw new Error(`HubSpot Buyers ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();

    for (const { properties: p } of (data.results || [])) {
      const term = p.utm_term_tbs || 'sem_term';
      byTerm[term] = (byTerm[term] || 0) + 1;
      total++;
    }

    after = data.paging?.next?.after;
  } while (after);

  return { total, byTerm };
}
