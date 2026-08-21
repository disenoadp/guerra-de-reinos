const express = require('express');
const neo4j = require('neo4j-driver');
const app = express();
const PORT = process.env.PORT || 3000;

const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

app.get('/', (req, res) => {
    res.send('<h1>Guerra de Reinos</h1><p>El servidor del continente esta activo.</p>');
});

// Ruta para ver el mapa y quien lo posee
app.get('/mapa', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(`
            MATCH (t:Territorio)
            OPTIONAL MATCH (j:Jugador)-[:POSEE]->(t)
            RETURN t.nombre AS nombre, j.nombre AS jugador
        `);
        
        const territorios = result.records.map(record => {
            const nombre = record.get('nombre');
            const jugador = record.get('jugador');
            return jugador ? `${nombre} (Ocupado por ${jugador})` : `${nombre} (Vacio)`;
        });

        if (territorios.length === 0) {
            res.send('<h1>Mapa de Aethel</h1><p>El mapa esta vacio. Visita /generar-mapa para crear territorios.</p>');
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

// Ruta para generar el mapa de prueba
app.get('/generar-mapa', async (req, res) => {
    const session = driver.session();
    try {
        await session.run('MATCH (n) DETACH DELETE n');
        for (let i = 1; i <= 5; i++) {
            await session.run('CREATE (t:Territorio {id: $id, nombre: $nombre, ocupado: false})', { 
                id: i, 
                nombre: `Territorio ${i}` 
            });
        }
        for (let i = 1; i < 5; i++) {
            await session.run(`
                MATCH (a:Territorio {id: $a}), (b:Territorio {id: $b})
                CREATE (a)-[:FRONTERA]->(b)
                CREATE (b)-[:FRONTERA]->(a)
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

// Ruta de Registro
app.get('/registrar/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const result = await session.run(`
            MATCH (t:Territorio {ocupado: false}) 
            RETURN t.nombre AS nombre 
            ORDER BY rand() 
            LIMIT 1
        `);
        
        if (result.records.length === 0) {
            return res.send('No hay territorios vacios para colonizar.');
        }

        const territorioNombre = result.records[0].get('nombre');

        await session.run(`
            MATCH (t:Territorio {nombre: $nombre})
            CREATE (j:Jugador {nombre: $jugador})
            CREATE (j)-[:POSEE]->(t)
            SET t.ocupado = true, 
                t.hierro = 500, 
                t.madera = 500, 
                t.oro = 200, 
                t.alimento = 200,
                t.nivel_mina_hierro = 0,
                t.nivel_aserradero = 0
        `, { nombre: territorioNombre, jugador: nombreJugador });

        res.send(`<h1>Bienvenido, ${nombreJugador}</h1><p>Has reclamado el ${territorioNombre}. Visita /panel/${nombreJugador}</p>`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al registrar jugador.');
    } finally {
        await session.close();
    }
});

// Ruta para Construir Mina de Hierro
app.get('/construir/:nombre/mina-hierro', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        // 1. Obtenemos nivel actual y recursos
        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            RETURN t.nivel_mina_hierro AS nivel, t.hierro AS hierro, t.madera AS madera
        `, { nombre: nombreJugador });

        if (result.records.length === 0) return res.send('Jugador no encontrado.');

        const data = result.records[0];
        const nivelActual = data.get('nivel').toNumber();
        const hierroActual = data.get('hierro').toNumber();
        const maderaActual = data.get('madera').toNumber();

        // 2. Calculamos coste y OBLIGAMOS a que sea entero con Math.floor
        const costeHierro = Math.floor(100 * Math.pow(1.5, nivelActual));
        const costeMadera = Math.floor(50 * Math.pow(1.5, nivelActual));

        // 3. Comprobamos si puede pagar
        if (hierroActual < costeHierro || maderaActual < costeMadera) {
            return res.send(`Recursos insuficientes. Necesitas ${costeHierro} Hierro y ${costeMadera} Madera. <a href="/panel/${nombreJugador}">Volver</a>`);
        }

        // 4. Restamos recursos y subimos nivel. Usamos toInteger en Cypher por seguridad
        await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            SET t.hierro = toInteger(t.hierro - $costeH), 
                t.madera = toInteger(t.madera - $costeM), 
                t.nivel_mina_hierro = toInteger(t.nivel_mina_hierro + 1)
        `, { nombre: nombreJugador, costeH: costeHierro, costeM: costeMadera });

        res.send(`<h1>Construccion exitosa!</h1><p>Mina de Hierro ahora es nivel ${nivelActual + 1}.</p><a href="/panel/${nombreJugador}">Volver al panel</a>`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al construir.');
    } finally {
        await session.close();
    }
});

// Ruta del Panel de Control
app.get('/panel/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            RETURN t.nombre AS territorio, 
                   t.hierro AS hierro, 
                   t.madera AS madera, 
                   t.oro AS oro, 
                   t.alimento AS alimento,
                   t.nivel_mina_hierro AS nivel_mina
        `, { nombre: nombreJugador });

        if (result.records.length === 0) {
            return res.send('Jugador no encontrado.');
        }

        const data = result.records[0];
        const nivelMina = data.get('nivel_mina').toNumber();
        const hierro = data.get('hierro').toNumber();
        const madera = data.get('madera').toNumber();
        const oro = data.get('oro').toNumber();
        const alimento = data.get('alimento').toNumber();
        
        // Calculamos el coste de la proxima mejora
        const costeHierro = Math.floor(100 * Math.pow(1.5, nivelMina));
        const costeMadera = Math.floor(50 * Math.pow(1.5, nivelMina));
        
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
                    .btn { background: #e67e22; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; float: right; }
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
                    <div class="edificio">
                        <b>Mina de Hierro (Nivel ${nivelMina})</b><br>
                        <small>Coste de mejora: ${costeHierro} Hierro, ${costeMadera} Madera</small>
                        <a href="/construir/${nombreJugador}/mina-hierro" class="btn">Mejorar</a>
                    </div>
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
