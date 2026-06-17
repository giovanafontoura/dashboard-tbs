export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado nas variáveis de ambiente do Vercel' });
  }

  try {
    const contacts = await fetchAllContacts(token);

    const waByTerm   = {};
    const emByTerm   = {};
    const dealsByTerm = {};
    const byDay      = {};
    const byDayByTerm = {};

    let dealsTotal = 0;

    for (const { properties: p } of contacts) {
      const fonte = (p.fonte__tbs_ || '').toLowerCase();
      const det   = (p.detalhamento_1_da_fonte__tbs_ || '').toLowerCase();
      const isWA  = fonte === 'organic social' && det === 'whatsapp';
      const isEM  = fonte === 'email marketing';

      if (!isWA && !isEM) continue;

      const term    = p.utm_term_tbs || 'sem_term';
      const day     = p.tbs_2026__data_de_inscricao
                        ? p.tbs_2026__data_de_inscricao.slice(0, 10)
                        : null;
      const comprou = !!p.tbschool__data_do_pagamento;

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
      if (comprou) {
        dealsByTerm[term] = (dealsByTerm[term] || 0) + 1;
        dealsTotal++;
      }
    }

    const totWA = Object.values(waByTerm).reduce((a, b) => a + b, 0);
    const totEM = Object.values(emByTerm).reduce((a, b) => a + b, 0);

    return res.json({
      waByTerm,
      emByTerm,
      byDay,
      byDayByTerm,
      dealsByTerm,
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
        'tbs_2026__data_de_inscricao',
        'tbschool__data_do_pagamento'
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
