// /api/ai-chat.js — Claude + Mem0 memoria profesional
const supabase = require('../lib/supabase');

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_BASE = 'https://api.mem0.ai/v1';

// ═══ MEM0 — guardar memoria ═══
async function mem0Guardar(userId, mensajes) {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${MEM0_API_KEY}`
      },
      body: JSON.stringify({
        messages: mensajes,
        user_id: userId,
        output_format: 'v1.1'
      })
    });
    const data = await res.json();
    return data;
  } catch(e) {
    console.error('Mem0 guardar error:', e.message);
    return null;
  }
}

// ═══ MEM0 — buscar memorias relevantes ═══
async function mem0Buscar(userId, query) {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/search/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${MEM0_API_KEY}`
      },
      body: JSON.stringify({
        query,
        user_id: userId,
        limit: 20,
        output_format: 'v1.1'
      })
    });
    const data = await res.json();
    return (data.results || []).map(m => m.memory).join('\n');
  } catch(e) {
    console.error('Mem0 buscar error:', e.message);
    return '';
  }
}

// ═══ MEM0 — traer todas las memorias del usuario ═══
async function mem0TraerTodo(userId) {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/?user_id=${userId}&output_format=v1.1`, {
      headers: { 'Authorization': `Token ${MEM0_API_KEY}` }
    });
    const data = await res.json();
    return (data.results || []).map(m => m.memory).join('\n');
  } catch(e) {
    console.error('Mem0 traer error:', e.message);
    return '';
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { message, history = [], imagen_base64, user_id } = req.body;
  if (!message && !imagen_base64) return res.status(400).json({ error: 'Mensaje requerido' });
  if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

  try {
    // 1. Contexto financiero en tiempo real
    const contexto = await buildContexto(user_id);

    // 2. Buscar memorias en Mem0 con timeout de 5 segundos
    let memoria = 'Sin memoria previa.';
    try {
      const memPromise = mem0TraerTodo(user_id);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
      memoria = await Promise.race([memPromise, timeout]) || 'Sin memoria previa.';
    } catch(e) {
      console.log('Mem0 no disponible, continuando sin memoria');
    }

    // 3. Construir system prompt con contexto + memoria
    const systemPrompt = buildSystemPrompt(contexto, memoria);

    // 4. Llamar a Claude
    const respuesta = await llamarClaude(systemPrompt, history, message, imagen_base64);
    const respuestaLimpia = respuesta
      .replace(/\[ACCION:[^\]]+\]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 5. Ejecutar acciones (registrar gastos, eventos, etc.)
    const acciones = await ejecutarAcciones(respuesta, contexto, user_id);

    // 6. Guardar en Mem0 en segundo plano — no bloquea la respuesta
    mem0Guardar(user_id, [
      { role: 'user', content: message },
      { role: 'assistant', content: respuestaLimpia }
    ]).catch(e => console.log('Mem0 guardar falló silenciosamente:', e.message));

    return res.json({ ok: true, respuesta: respuestaLimpia, acciones });
  } catch (error) {
    console.error('AI chat error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ═══ CONTEXTO FINANCIERO COMPLETO ═══
async function buildContexto(userId) {
  const [
    { data: cuentas },
    { data: movsMes },
    { data: movsRecientes },
    { data: pagos },
    { data: eventos },
    { data: cajas },
    { data: metas }
  ] = await Promise.all([
    supabase.from('accounts').select('*').eq('user_id', userId),
    supabase.from('movements').select('*').eq('user_id', userId)
      .gte('fecha', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0])
      .order('fecha', { ascending: false }).limit(50),
    supabase.from('movements').select('*').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('payments').select('*').eq('user_id', userId).neq('status', 'pagado'),
    supabase.from('events').select('*').eq('user_id', userId)
      .gte('fecha', new Date().toISOString().split('T')[0]).order('fecha').limit(10),
    supabase.from('cajas').select('*').eq('user_id', userId),
    supabase.from('metas').select('*, micrometas(*)').eq('user_id', userId).eq('estado', 'activa')
  ]);

  const totalSaldo = (cuentas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const totalCajas = (cajas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const ingresosMes = (movsMes || []).filter(m => m.tipo === 'ingreso').reduce((a, m) => a + parseFloat(m.monto), 0);
  const gastosMes = (movsMes || []).filter(m => m.tipo === 'gasto').reduce((a, m) => a + parseFloat(m.monto), 0);

  return {
    totalSaldo, totalCajas, ingresosMes, gastosMes,
    cuentas: cuentas || [], movimientos: movsMes || [],
    movsRecientes: movsRecientes || [], pagos: pagos || [],
    eventos: eventos || [], cajas: cajas || [], metas: metas || []
  };
}

// ═══ SYSTEM PROMPT ═══
function buildSystemPrompt(ctx, memoria) {
  const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
  const hoy = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `Eres Ana, agente financiero personal. Tienes MEMORIA COMPLETA del usuario y acceso TOTAL a sus finanzas.

HOY: ${hoy}

═══ LO QUE SABES DEL USUARIO (memoria persistente) ═══
${memoria || 'Primera vez que hablas con este usuario — aprende todo lo posible.'}

═══ ESTADO FINANCIERO EN TIEMPO REAL ═══
Total bancos: ${fmt(ctx.totalSaldo)}
Total efectivo: ${fmt(ctx.totalCajas)}
TOTAL DISPONIBLE: ${fmt(ctx.totalSaldo + ctx.totalCajas)}

Cuentas: ${ctx.cuentas.map(c => `${c.nombre}(${fmt(c.saldo)})[ID:${c.id}]`).join(' | ') || 'ninguna'}
Cajas: ${ctx.cajas.map(c => `${c.nombre}(${fmt(c.saldo)})[ID:${c.id}]`).join(' | ') || 'ninguna'}
Mes: Ingresos ${fmt(ctx.ingresosMes)} | Gastos ${fmt(ctx.gastosMes)} | Balance ${fmt(ctx.ingresosMes - ctx.gastosMes)}

Últimos movimientos:
${ctx.movsRecientes.map(m => `• ${m.tipo==='ingreso'?'↑':'↓'} ${fmt(m.monto)} — ${m.descripcion} (${m.fecha}) [ID:${m.id}]`).join('\n') || 'ninguno'}

Todos del mes:
${ctx.movimientos.map(m => `• ${m.tipo==='ingreso'?'+':'-'}${fmt(m.monto)} ${m.descripcion} ${m.fecha} [ID:${m.id}]`).join('\n') || 'ninguno'}

Pagos pendientes:
${ctx.pagos.map(p => `• ${p.nombre}: ${fmt(p.monto)} vence ${p.fecha_limite} [ID:${p.id}]`).join('\n') || 'ninguno'}

Eventos próximos:
${ctx.eventos.map(e => `• ${e.titulo} — ${e.fecha} ${e.hora||''} [ID:${e.id}]`).join('\n') || 'ninguno'}

Metas activas:
${ctx.metas.map(m => `• ${m.titulo} — ${m.progreso||0}% [ID:${m.id}]`).join('\n') || 'ninguna'}

═══ ACCIONES INVISIBLES — úsalas al final de tu respuesta ═══
[ACCION:gasto|monto|descripcion|categoria]
[ACCION:ingreso|monto|descripcion|categoria]
[ACCION:pago|nombre|monto|YYYY-MM-DD]
[ACCION:evento|titulo|YYYY-MM-DD|HH:MM]
[ACCION:recordatorio|texto]
[ACCION:meta|titulo|tipo|monto_objetivo|YYYY-MM-DD]
[ACCION:borrar_movimiento|ID]
[ACCION:borrar_pago|ID]
[ACCION:borrar_evento|ID]

═══ REGLAS ═══
1. NUNCA muestres [ACCION:...] — son invisibles
2. Registra gastos/ingresos INMEDIATAMENTE cuando los mencionen
3. Confirma: "✅ Registré $X en Y"
4. TODO lo que registres aparece visible en la app
5. Respuestas CORTAS — máx 3 líneas salvo análisis
6. Español colombiano, tono cálido y cercano
7. RECUERDAS TODO — úsalo naturalmente
8. Si te preguntan qué recuerdas → cuéntale todo`;
}

// ═══ LLAMAR A CLAUDE ═══
async function llamarClaude(system, history, message, imagen) {
  const userContent = [];
  if (imagen) userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagen } });
  userContent.push({ type: 'text', text: message || 'Analiza esta imagen' });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system,
      messages: [...history.slice(-14), { role: 'user', content: userContent }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

// ═══ EJECUTAR ACCIONES — todo queda visible en la app ═══
async function ejecutarAcciones(respuesta, contexto, userId) {
  const matches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
  const ejecutadas = [];

  for (const match of matches) {
    const parts = match[1].split('|');
    const accion = parts[0].trim();

    try {
      if (accion === 'gasto' || accion === 'ingreso') {
        const monto = parseFloat(parts[1]);
        const desc = (parts[2] || 'Sin descripción').trim();
        const cat = (parts[3] || 'otro').trim();
        if (!monto || monto <= 0) continue;

        const cuentaId = contexto.cuentas[0]?.id || null;
        const { data: mov, error } = await supabase
          .from('movements')
          .insert({
            user_id: userId, tipo: accion, descripcion: desc,
            monto, fecha: new Date().toISOString().split('T')[0],
            account_id: cuentaId, categoria: cat, source: 'ia'
          })
          .select().single();

        if (error) { console.error('Error movimiento:', error.message); continue; }

        if (cuentaId && contexto.cuentas[0]) {
          const saldo = parseFloat(contexto.cuentas[0].saldo || 0);
          const nuevo = accion === 'ingreso' ? saldo + monto : saldo - monto;
          await supabase.from('accounts').update({ saldo: nuevo }).eq('id', cuentaId).eq('user_id', userId);
        }
        ejecutadas.push({ accion, monto, desc, id: mov.id });

      } else if (accion === 'borrar_movimiento') {
        const { error } = await supabase.from('movements').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'movimiento' });

      } else if (accion === 'borrar_pago') {
        const { error } = await supabase.from('payments').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'pago' });

      } else if (accion === 'borrar_evento') {
        const { error } = await supabase.from('events').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'evento' });

      } else if (accion === 'pago') {
        const { error } = await supabase.from('payments').insert({
          user_id: userId, nombre: parts[1],
          monto: parseFloat(parts[2]), fecha_limite: parts[3], status: 'pendiente'
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'evento') {
        const { error } = await supabase.from('events').insert({
          user_id: userId, titulo: parts[1],
          fecha: parts[2], hora: parts[3] || null, nota: 'Creado por IA'
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'recordatorio') {
        const { error } = await supabase.from('reminders').insert({
          user_id: userId, tipo: 'nota', titulo: parts[1],
          content: { texto: parts[1] }, fecha: new Date().toISOString().split('T')[0]
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'meta') {
        const { error } = await supabase.from('metas').insert({
          user_id: userId, titulo: parts[1], tipo: parts[2] || 'personal',
          monto_objetivo: parseFloat(parts[3]) || null,
          fecha_limite: parts[4] || null,
          año: new Date().getFullYear(), estado: 'activa', progreso: 0
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });
      }
    } catch(e) {
      console.error('Error acción:', accion, e.message);
    }
  }
  return ejecutadas;
}
