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

// Ruta para ver el mapa actual
app.get('/mapa', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run('MATCH (t:Territorio) RETURN t.nombre AS nombre');
        const territorios = result.records.map(record => record.get('nombre'));
        
        if (territorios.length === 0) {
            res.send('<h1>Mapa de Aethel</h1><p>El mapa esta vacio. Visita /generar-mapa para crear territorios.</p>');
        } else {
            res.send(`<h1>Mapa de Aethel</h1><p>Territorios existentes:</p><ul>${territorios.map(t => `<li>${t}</li>`).join('')}</ul>`);
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al conectar con la base de datos.');
    } finally {
        await session.close();
    }
});

// Ruta para generar un mapa de prueba (5 territorios conectados)
app.get('/generar-mapa', async (req, res) => {
    const session = driver.session();
    try {
        // 1. Borramos el mapa anterior (para que no se duplique si visitas esto 2 veces)
        await session.run('MATCH (n) DETACH DELETE n');

        // 2. Creamos 5 territorios
        for (let i = 1; i <= 5; i++) {
            await session.run('CREATE (t:Territorio {id: $id, nombre: $nombre, ocupado: false})', { 
                id: i, 
                nombre: `Territorio ${i}` 
            });
        }

        // 3. Conectamos los territorios (1-2, 2-3, 3-4, 4-5) en ambas direcciones
        for (let i = 1; i < 5; i++) {
            await session.run(`
                MATCH (a:Territorio {id: $a}), (b:Territorio {id: $b})
                CREATE (a)-[:FRONTERA]->(b)
                CREATE (b)-[:FRONTERA]->(a)
            `, { a: i, b: i + 1 });
        }

        res.send('Mapa generado con exito. Se crearon 5 territorios conectados.');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al generar el mapa.');
    } finally {
        await session.close();
    }
});

app.listen(PORT, () => {
    console.log(`El Reino esta corriendo en el puerto ${PORT}`);
});
