const express = require('express');
const neo4j = require('neo4j-driver');
const app = express();
const PORT = process.env.PORT || 3000;

const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

function toNum(val) {
    if (val === null || val === undefined) return 0;
    return typeof val === 'number' ? val : val.toNumber();
}

async function actualizarRecursos(session, jugador) {
    const ahora = Date.now();
    await session.run(`
        MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta)
        SET p.metal = toInteger(p.metal + (toFloat($ahora - p.ultima_visita)/1000.0) * (p.nivel_mina_metal * 30.0 / 3600.0)),
            p.cristal = toInteger(p.cristal + (toFloat($ahora - p.ultima_visita)/1000.0) * (p.nivel_mina_cristal * 20.0 / 3600.0)),
            p.deuterio = toInteger(p.deuterio + (toFloat($ahora - p.ultima_visita)/1000.0) * (p.nivel_sintetizador * 10.0 / 3600.0)),
            p.ultima_visita = $ahora
    `, { nombre: jugador, ahora });
}

async function resolverFlotas(session, jugador) {
    const ahora = Date.now();
    const result = await session.run(`
        MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(o:Planeta)
        WHERE o.ataque_fin IS NOT NULL AND o.ataque_fin <= $ahora
        RETURN o.nombre AS o, o.ataque_destino AS d, o.ataque_tropas AS t
    `, { nombre: jugador, ahora });

    for (const record of result.records) {
        const o = record.get('o'); const d = record.get('d'); const t = toNum(record.get('t'));
        await session.run(`
            MATCH (origen:Planeta {nombre: $o}), (destino:Planeta {nombre: $d})
            SET origen.metal = toInteger(origen.metal + destino.metal * 0.5),
                origen.cristal = toInteger(origen.cristal + destino.cristal * 0.5),
                destino.metal = toInteger(destino.metal * 0.5),
                destino.cristal = toInteger(destino.cristal * 0.5),
                origen.naves_cazador = toInteger(origen.naves_cazador + $t),
                origen.ataque_fin = null, origen.ataque_destino = null, origen.ataque_tropas = 0
        `, { o, d, t });
    }
}

// --- LOGIN Y UNIVERSO ---
app.get('/', (req, res) => res.render('login', { error: null, success: null }));

app.post('/entrar', async (req, res) => {
    const nombre = req.body.usuario;
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre}) RETURN j`, { nombre });
        if (result.records.length > 0) res.redirect(`/panel/${nombre}`);
        else res.render('login', { error: 'Ese jugador no existe en el universo.', success: null });
    } catch (e) { res.status(500).send('Error'); } finally { await session.close(); }
});

app.post('/crear', async (req, res) => {
    const nombre = req.body.usuario;
    const session = driver.session();
    try {
        const check = await session.run(`MATCH (j:Jugador {nombre: $nombre}) RETURN j`, { nombre });
        if (check.records.length > 0) return res.render('login', { error: 'Nombre en uso.', success: null });
        
        const result = await session.run(`MATCH (p:Planeta {ocupado: false}) RETURN p.coords AS coords ORDER BY rand() LIMIT 1`);
        if (result.records.length === 0) return res.render('login', { error: 'Universo lleno.', success: null });
        
        const coords = result.records[0].get('coords');
        await session.run(`
            MATCH (p:Planeta {coords: $coords})
            CREATE (j:Jugador {nombre: $nombre}) CREATE (j)-[:POSEE]->(p)
            SET p.ocupado = true, p.metal = 500, p.cristal = 500, p.deuterio = 0,
                p.nivel_mina_metal = 0, p.nivel_mina_cristal = 0, p.nivel_sintetizador = 0, p.nivel_planta = 0, p.nivel_hangar = 0,
                p.naves_cazador = 0,
                p.construccion_fin = null, p.construccion_tipo = null,
                p.entrenando_fin = null, p.entrenando_tipo = null,
                p.ataque_fin = null, p.ataque_destino = null, p.ataque_tropas = 0,
                p.ultima_visita = $ahora
        `, { coords, nombre, ahora: Date.now() });
        res.redirect(`/panel/${nombre}`);
    } catch (e) { res.status(500).send('Error'); } finally { await session.close(); }
});

app.get('/generar-universo', async (req, res) => {
    const session = driver.session();
    try {
        await session.run('MATCH (n) DETACH DELETE n');
        await session.run(`UNWIND range(1, 9) AS g UNWIND range(1, 10) AS s UNWIND range(1, 5) AS p MERGE (planet:Planeta {coords: g + ':' + s + ':' + p, ocupado: false, galaxia: g, sistema: s, posicion: p})`);
        res.render('login', { error: null, success: 'Universo generado. 450 planetas creados.' });
    } catch (error) { res.status(500).send('Error'); } finally { await session.close(); }
});

// --- PANEL (DASHBOARD) ---
app.get('/panel/:nombre/:pagina?', async (req, res) => {
    const jugador = req.params.nombre;
    const pagina = req.params.pagina || 'recursos';
    const session = driver.session();
    try {
        const ahora = Date.now();
        await resolverFlotas(session, jugador);
        
        await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) WHERE p.construccion_fin IS NOT NULL AND p.construccion_fin <= $ahora SET p.nivel_mina_metal = CASE WHEN p.construccion_tipo = 'mina_metal' THEN p.nivel_mina_metal + 1 ELSE p.nivel_mina_metal END, p.nivel_mina_cristal = CASE WHEN p.construccion_tipo = 'mina_cristal' THEN p.nivel_mina_cristal + 1 ELSE p.nivel_mina_cristal END, p.nivel_sintetizador = CASE WHEN p.construccion_tipo = 'sintetizador' THEN p.nivel_sintetizador + 1 ELSE p.nivel_sintetizador END, p.nivel_hangar = CASE WHEN p.construccion_tipo = 'hangar' THEN p.nivel_hangar + 1 ELSE p.nivel_hangar END, p.construccion_fin = null, p.construccion_tipo = null`, { nombre: jugador, ahora });
        
        await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) WHERE p.entrenando_fin IS NOT NULL AND p.entrenando_fin <= $ahora SET p.naves_cazador = p.naves_cazador + 1, p.entrenando_fin = null, p.entrenando_tipo = null`, { nombre: jugador, ahora });
        
        await actualizarRecursos(session, jugador);
        
        const result = await session.run(`
            MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) 
            RETURN p.coords AS coords, p.metal AS metal, p.cristal AS cristal, p.deuterio AS deuterio, 
                   p.nivel_mina_metal AS m_metal, p.nivel_mina_cristal AS m_cristal, p.nivel_sintetizador AS m_deut, p.nivel_hangar AS m_hangar,
                   p.naves_cazador AS cazador, p.construccion_fin AS fin_c, p.construccion_tipo AS tipo_c, 
                   p.entrenando_fin AS fin_e, p.ataque_fin AS fin_a, p.ataque_destino AS destino_a
        `, { nombre: jugador });
        
        if (result.records.length === 0) return res.send('Jugador no encontrado.');
        const d = result.records[0];
        
        const calcTiempo = (fin) => fin ? Math.max(0, Math.floor((toNum(fin) - ahora) / 1000)) : 0;

        res.render('panel', {
            jugador, pagina, coords: d.get('coords'),
            metal: toNum(d.get('metal')), cristal: toNum(d.get('cristal')), deuterio: toNum(d.get('deuterio')),
            m_metal: toNum(d.get('m_metal')), m_cristal: toNum(d.get('m_cristal')), m_deut: toNum(d.get('m_deut')), m_hangar: toNum(d.get('m_hangar')),
            cazador: toNum(d.get('cazador')),
            tiempo_construccion: calcTiempo(d.get('fin_c')), tipo_construccion: d.get('tipo_c'),
            tiempo_entrenamiento: calcTiempo(d.get('fin_e')),
            tiempo_ataque: calcTiempo(d.get('fin_a')), ataque_destino: d.get('destino_a')
        });
    } catch (e) { console.error(e); res.status(500).send('Error'); } finally { await session.close(); }
});

// --- ACCIONES ---
app.get('/construir/:nombre/:edificio', async (req, res) => {
    const { nombre, edificio } = req.params;
    const session = driver.session();
    const niveles = { 'mina_metal': 'nivel_mina_metal', 'mina_cristal': 'nivel_mina_cristal', 'sintetizador': 'nivel_sintetizador', 'hangar': 'nivel_hangar' };
    try {
        await actualizarRecursos(session, nombre);
        const result = await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) RETURN p.${niveles[edificio]} AS nivel, p.metal AS metal, p.cristal AS cristal, p.construccion_fin AS fin`, { nombre });
        if (result.records.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const d = result.records[0];
        if (d.get('fin') !== null) return res.status(400).json({ error: 'Ya hay construcción en curso.' });
        const costeM = Math.floor(60 * Math.pow(1.5, toNum(d.get('nivel'))));
        const costeC = Math.floor(15 * Math.pow(1.5, toNum(d.get('nivel'))));
        if (toNum(d.get('metal')) < costeM || toNum(d.get('cristal')) < costeC) return res.status(400).json({ error: 'Sin recursos.' });
        const tiempoFin = Date.now() + (60 + (toNum(d.get('nivel')) * 60) * 1000);
        await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) SET p.metal = toInteger(p.metal - $cM), p.cristal = toInteger(p.cristal - $cC), p.construccion_tipo = $e, p.construccion_fin = $t`, { nombre, cM: costeM, cC: costeC, e: edificio, t: tiempoFin });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error interno' }); } finally { await session.close(); }
});

app.get('/entrenar/:nombre/:nave', async (req, res) => {
    const { nombre, nave } = req.params;
    const session = driver.session();
    try {
        await actualizarRecursos(session, nombre);
        const result = await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) RETURN p.nivel_hangar AS hangar, p.metal AS metal, p.cristal AS cristal, p.entrenando_fin AS fin`, { nombre });
        if (result.records.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const d = result.records[0];
        if (toNum(d.get('hangar')) === 0) return res.status(400).json({ error: 'Sin hangar.' });
        if (d.get('fin') !== null) return res.status(400).json({ error: 'Hangar ocupado.' });
        if (toNum(d.get('metal')) < 3000 || toNum(d.get('cristal')) < 1000) return res.status(400).json({ error: 'Sin recursos.' });
        const tiempoFin = Date.now() + 30000;
        await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) SET p.metal = toInteger(p.metal - 3000), p.cristal = toInteger(p.cristal - 1000), p.entrenando_tipo = $n, p.entrenando_fin = $t`, { nombre, n: nave, t: tiempoFin });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); } finally { await session.close(); }
});

// --- GALAXIA Y FLOTAS ---
app.get('/galaxia/:nombre', async (req, res) => {
    const nombre = req.params.nombre;
    const session = driver.session();
    try {
        const userData = await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) RETURN p.coords AS coords, p.metal AS metal, p.cristal AS cristal, p.deuterio AS deuterio`, { nombre });
        if (userData.records.length === 0) return res.send('No encontrado');
        const u = userData.records[0];

        const result = await session.run(`MATCH (p:Planeta) OPTIONAL MATCH (j:Jugador)-[:POSEE]->(p) RETURN p.coords AS coords, j.nombre AS jugador ORDER BY p.galaxia, p.sistema, p.posicion`);
        const planetas = result.records.map(r => ({ coords: r.get('coords'), jugador: r.get('jugador') }));

        res.render('galaxia', {
            jugador: nombre, planetas, tusCoords: u.get('coords'),
            metal: toNum(u.get('metal')), cristal: toNum(u.get('cristal')), deuterio: toNum(u.get('deuterio'))
        });
    } catch (e) { res.status(500).send('Error'); } finally { await session.close(); }
});

app.get('/atacar/:nombre/:destino', async (req, res) => {
    const { nombre, destino } = req.params;
    const session = driver.session();
    try {
        await actualizarRecursos(session, nombre);
        const result = await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(o:Planeta), (d:Planeta {coords: $destino}) RETURN o.coords AS oc, o.naves_cazador AS t, o.ataque_fin AS fin, d.galaxia AS dg, d.sistema AS ds, d.posicion AS dp, o.galaxia AS og, o.sistema AS os, o.posicion AS op`, { nombre, destino });
        if (result.records.length === 0) return res.status(400).json({ error: 'Destino no encontrado.' });
        const d = result.records[0];
        if (d.get('oc') === destino) return res.redirect(`/panel/${nombre}`);
        if (d.get('fin') !== null) return res.redirect(`/panel/${nombre}`);
        if (toNum(d.get('t')) === 0) return res.redirect(`/panel/${nombre}`);
        
        const distancia = Math.abs(toNum(d.get('os')) - toNum(d.get('ds'))) || 1;
        const tiempoFin = Date.now() + (distancia * 10 * 1000);
        
        await session.run(`MATCH (:Jugador {nombre: $nombre})-[:POSEE]->(p:Planeta) SET p.naves_cazador = toInteger(p.naves_cazador - $t), p.ataque_destino = $d, p.ataque_fin = $f, p.ataque_tropas = $t`, { nombre, d: destino, f: tiempoFin, t: toNum(d.get('t')) });
        res.redirect(`/panel/${nombre}/flota`);
    } catch (e) { res.status(500).json({ error: 'Error' }); } finally { await session.close(); }
});

app.listen(PORT, () => console.log(`OGame clon corriendo en ${PORT}`));
