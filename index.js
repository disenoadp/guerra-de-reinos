const express = require('express');
const neo4j = require('neo4j-driver');
const app = express();
const PORT = process.env.PORT || 3000;

const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

function toNum(val) {
    if (val === null || val === undefined) return null;
    return typeof val === 'number' ? val : val.toNumber();
}

// Función para actualizar recursos perezosamente
async function actualizarRecursos(session, nombreJugador) {
    const ahora = Date.now();
    await session.run(`
        MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
        SET t.hierro = toInteger(t.hierro + (toFloat($ahora - t.ultima_visita)/1000.0) * (t.nivel_mina_hierro * 1000.0 / 3600.0)),
            t.madera = toInteger(t.madera + (toFloat($ahora - t.ultima_visita)/1000.0) * (t.nivel_aserradero * 800.0 / 3600.0)),
            t.alimento = toInteger(t.alimento + (toFloat($ahora - t.ultima_visita)/1000.0) * (t.nivel_granja * 600.0 / 3600.0)),
            t.ultima_visita = $ahora
    `, { nombre: nombreJugador, ahora: ahora });
}

app.get('/', (req, res) => {
    res.send('<h1>Guerra de Reinos</h1><p>El servidor del continente esta activo.</p>');
});

app.get('/mapa', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(`
            MATCH (t:Territorio) OPTIONAL MATCH (j:Jugador)-[:POSEE]->(t)
            RETURN t.nombre AS nombre, j.nombre AS jugador
        `);
        const territorios = result.records.map(record => {
            const nombre = record.get('nombre');
            const jugador = record.get('jugador');
            return jugador ? `${nombre} (Ocupado por ${jugador})` : `${nombre} (Vacio)`;
        });
        if (territorios.length === 0) {
            res.send('<h1>Mapa de Aethel</h1><p>El mapa esta vacio. Visita /generar-mapa.</p>');
        } else {
            res.send(`<h1>Mapa de Aethel</h1><ul>${territorios.map(t => `<li>${t}</li>`).join('')}</ul>`);
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al conectar con la base de datos.');
    } finally {
        await session.close();
    }
});

app.get('/generar-mapa', async (req, res) => {
    const session = driver.session();
    try {
        await session.run('MATCH (n) DETACH DELETE n');
        for (let i = 1; i <= 5; i++) {
            await session.run('CREATE (t:Territorio {id: $id, nombre: $nombre, ocupado: false})', { id: i, nombre: `Territorio ${i}` });
        }
        for (let i = 1; i < 5; i++) {
            await session.run(`
                MATCH (a:Territorio {id: $a}), (b:Territorio {id: $b})
                CREATE (a)-[:FRONTERA]->(b) CREATE (b)-[:FRONTERA]->(a)
            `, { a: i, b: i + 1 });
        }
        res.send('Mapa generado con exito.');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al generar el mapa.');
    } finally {
        await session.close();
    }
});

app.get('/registrar/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (t:Territorio {ocupado: false}) RETURN t.nombre AS nombre ORDER BY rand() LIMIT 1`);
        if (result.records.length === 0) return res.send('No hay territorios vacios.');
        const territorioNombre = result.records[0].get('nombre');
        await session.run(`
            MATCH (t:Territorio {nombre: $nombre})
            CREATE (j:Jugador {nombre: $jugador})
            CREATE (j)-[:POSEE]->(t)
            SET t.ocupado = true, 
                t.hierro = 500, t.madera = 500, t.oro = 200, t.alimento = 200,
                t.nivel_mina_hierro = 0, 
                t.nivel_aserradero = 0,
                t.nivel_granja = 0,
                t.construccion_tipo = null,
                t.construccion_fin = null,
                t.ultima_visita = $ahora
        `, { nombre: territorioNombre, jugador: nombreJugador, ahora: Date.now() });
        res.send(`<h1>Bienvenido, ${nombreJugador}</h1><p>Visita /panel/${nombreJugador}</p>`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al registrar.');
    } finally {
        await session.close();
    }
});

// Ruta genérica para construir cualquier edificio
app.get('/construir/:nombre/:edificio', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const edificio = req.params.edificio;
    const session = driver.session();
    
    const niveles = {
        'mina-hierro': 'nivel_mina_hierro',
        'aserradero': 'nivel_aserradero',
        'granja': 'nivel_granja'
    };
    const nivelKey = niveles[edificio];
    if (!nivelKey) return res.status(400).json({ error: 'Edificio no valido.' });

    try {
        await actualizarRecursos(session, nombreJugador);

        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            RETURN t[${nivelKey}] AS nivel, t.hierro AS hierro, t.madera AS madera, t.construccion_fin AS fin
        `, { nombre: nombreJugador });

        if (result.records.length === 0) return res.status(404).json({ error: 'Jugador no encontrado.' });

        const data = result.records[0];
        const nivelActual = toNum(data.get('nivel'));
        const hierroActual = toNum(data.get('hierro'));
        const maderaActual = toNum(data.get('madera'));
        const construccionFin = data.get('fin'); 

        if (construccionFin !== null) return res.status(400).json({ error: 'Ya hay un edificio en construccion en este territorio.' });

        const costeHierro = Math.floor(100 * Math.pow(1.5, nivelActual));
        const costeMadera = Math.floor(50 * Math.pow(1.5, nivelActual));

        if (hierroActual < costeHierro || maderaActual < costeMadera) {
            return res.status(400).json({ error: `Recursos insuficientes. Necesitas ${costeHierro} Hierro y ${costeMadera} Madera.` });
        }

        const tiempoConstruccionMs = (30 + (nivelActual * 30)) * 1000; 
        const tiempoFin = Date.now() + tiempoConstruccionMs;

        await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            SET t.hierro = toInteger(t.hierro - $costeH), 
                t.madera = toInteger(t.madera - $costeM), 
                t.construccion_tipo = $edificio,
                t.construccion_fin = $tiempoFin
        `, { nombre: nombreJugador, costeH: costeHierro, costeM: costeMadera, tiempoFin: tiempoFin, edificio: edificio });

        res.json({ success: true, tiempoFin: tiempoFin });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno.' });
    } finally {
        await session.close();
    }
});

// Función para generar el HTML de un edificio
function generarHtmlEdificio(nombreJugador, edificio, nivelActual, estaConstruyendo, tipoConstruccion, construccionFin, ahora) {
    const nombres = { 'mina-hierro': 'Mina de Hierro', 'aserradero': 'Aserradero', 'granja': 'Granja' };
    const produccion = { 'mina-hierro': nivelActual * 1000, 'aserradero': nivelActual * 800, 'granja': nivelActual * 600 };
    
    const costeHierro = Math.floor(100 * Math.pow(1.5, nivelActual));
    const costeMadera = Math.floor(50 * Math.pow(1.5, nivelActual));

    if (estaConstruyendo && tipoConstruccion === edificio) {
        const tiempoRestante = Math.max(0, Math.floor((construccionFin - ahora) / 1000));
        return `
            <div class="edificio">
                <b>${nombres[edificio]} (Nivel ${nivelActual})</b> - Prod: ${produccion[edificio]}/h<br>
                <small>Construyendo... Tiempo restante: <span id="timer-${edificio}">${tiempoRestante}</span>s</small>
                <div id="timer-msg-${edificio}" style="margin-top: 10px;"></div>
            </div>
            <script>
                let tiempo = document.getElementById('timer-${edificio}').innerText;
                setInterval(() => {
                    tiempo--;
                    if(tiempo <= 0) {
                        document.getElementById('timer-msg-${edificio}').innerHTML = '<b style="color:lightgreen;">Finalizada!</b> <a href="/panel/${nombreJugador}">Actualizar</a>';
                        document.getElementById('timer-${edificio}').style.display = 'none';
                    } else {
                        document.getElementById('timer-${edificio}').innerText = tiempo;
                    }
                }, 1000);
            </script>
        `;
    } else if (estaConstruyendo) {
        // Hay otro edificio construyéndose, mostramos deshabilitado
        return `
            <div class="edificio">
                <b>${nombres[edificio]} (Nivel ${nivelActual})</b> - Prod: ${produccion[edificio]}/h<br>
                <small>Esperando a que termine la otra construccion...</small>
            </div>
        `;
    } else {
        return `
            <div class="edificio">
                <b>${nombres[edificio]} (Nivel ${nivelActual})</b> - Prod: ${produccion[edificio]}/h<br>
                <small>Coste de mejora: ${costeHierro} Hierro, ${costeMadera} Madera</small>
                <button onclick="mejorar('${edificio}')" class="btn">Mejorar</button>
                <div id="msg-${edificio}" style="color: red; margin-top: 10px;"></div>
            </div>
            <script>
                async function mejorar(edif) {
                    const res = await fetch('/construir/${nombreJugador}/' + edif);
                    const data = await res.json();
                    if (data.success) { location.reload(); } 
                    else { document.getElementById('msg-' + edif).innerText = data.error; }
                }
            </script>
        `;
    }
}

app.get('/panel/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const ahora = Date.now();
        
        // 1. Finaliza construcción si el tiempo pasó
        await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            WHERE t.construccion_fin IS NOT NULL AND t.construccion_fin <= $ahora
            SET t.nivel_mina_hierro = CASE WHEN t.construccion_tipo = 'mina-hierro' THEN t.nivel_mina_hierro + 1 ELSE t.nivel_mina_hierro END,
                t.nivel_aserradero = CASE WHEN t.construccion_tipo = 'aserradero' THEN t.nivel_aserradero + 1 ELSE t.nivel_aserradero END,
                t.nivel_granja = CASE WHEN t.construccion_tipo = 'granja' THEN t.nivel_granja + 1 ELSE t.nivel_granja END,
                t.construccion_fin = null,
                t.construccion_tipo = null
        `, { nombre: nombreJugador, ahora: ahora });

        // 2. Actualiza recursos
        await actualizarRecursos(session, nombreJugador);

        // 3. Carga datos
        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            RETURN t.nombre AS territorio, t.hierro AS hierro, t.madera AS madera, 
                   t.oro AS oro, t.alimento AS alimento,
                   t.nivel_mina_hierro AS nivel_mina, t.nivel_aserradero AS nivel_aserradero, t.nivel_granja AS nivel_granja,
                   t.construccion_fin AS fin, t.construccion_tipo AS tipo
        `, { nombre: nombreJugador });

        if (result.records.length === 0) return res.send('Jugador no encontrado.');

        const data = result.records[0];
        const hierro = toNum(data.get('hierro'));
        const madera = toNum(data.get('madera'));
        const oro = toNum(data.get('oro'));
        const alimento = toNum(data.get('alimento'));
        const nivelMina = toNum(data.get('nivel_mina'));
        const nivelAserradero = toNum(data.get('nivel_aserradero'));
        const nivelGranja = toNum(data.get('nivel_granja'));
        const construccionFin = data.get('fin') ? toNum(data.get('fin')) : null;
        const tipoConstruccion = data.get('tipo');
        
        const htmlMina = generarHtmlEdificio(nombreJugador, 'mina-hierro', nivelMina, construccionFin !== null, tipoConstruccion, construccionFin, ahora);
        const htmlAserradero = generarHtmlEdificio(nombreJugador, 'aserradero', nivelAserradero, construccionFin !== null, tipoConstruccion, construccionFin, ahora);
        const htmlGranja = generarHtmlEdificio(nombreJugador, 'granja', nivelGranja, construccionFin !== null, tipoConstruccion, construccionFin, ahora);
        
        res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: Georgia, serif; background-color: #2c3e50; color: white; text-align: center; }
                    .panel { background-color: #34495e; width: 80%; margin: auto; padding: 20px; border-radius: 10px; margin-top: 50px; }
                    .recursos { display: flex; justify-content: space-around; margin-top: 20px; margin-bottom: 40px; }
                    .recurso { background: #2c3e50; padding: 15px; border-radius: 8px; width: 20%; }
                    .titulo { color: #f39c12; }
                    .edificio { background: #2c3e50; padding: 15px; border-radius: 8px; margin-top: 10px; text-align: left; }
                    .btn { background: #e67e22; color: white; padding: 10px 20px; border: none; border-radius: 5px; float: right; cursor: pointer; }
                    .btn:hover { background: #d35400; }
                </style>
            </head>
            <body>
                <div class="panel">
                    <h1 class="titulo">Panel del Reino</h1>
                    <h2>${nombreJugador}</h2>
                    <p>Territorio Actual: <b>${data.get('territorio')}</b></p>
                    
                    <div class="recursos">
                        <div class="recurso"><h3>Hierro</h3><p>${hierro}</p></div>
                        <div class="recurso"><h3>Madera</h3><p>${madera}</p></div>
                        <div class="recurso"><h3>Oro</h3><p>${oro}</p></div>
                        <div class="recurso"><h3>Alimento</h3><p>${alimento}</p></div>
                    </div>

                    <h3>Edificios</h3>
                    ${htmlMina}
                    ${htmlAserradero}
                    ${htmlGranja}
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar el panel.');
    } finally {
        await session.close();
    }
});

app.listen(PORT, () => {
    console.log(`El Reino esta corriendo en el puerto ${PORT}`);
});
