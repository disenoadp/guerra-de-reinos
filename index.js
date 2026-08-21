const express = require('express');
const neo4j = require('neo4j-driver');
const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Neo4j usando variables de entorno (las pondremos en Render)
const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

// Ruta principal
app.get('/', (req, res) => {
    res.send('<h1>Guerra de Reinos</h1><p>El servidor del continente esta activo.</p>');
});

// Ruta de prueba para conectar con la base de datos
app.get('/mapa', async (req, res) => {
    const session = driver.session();
    try {
        // Hacemos una consulta simple a la base de datos para ver si hay territorios
        const result = await session.run('MATCH (t:Territorio) RETURN count(t) AS total');
        const totalTerritorios = result.records[0].get('total').low;
        res.send(`<h1>Mapa de Aethel</h1><p>Base de datos conectada. Territorios actuales en el mapa: ${totalTerritorios}</p>`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al conectar con la base de datos.');
    } finally {
        await session.close();
    }
});

// Mantenemos el servidor escuchando
app.listen(PORT, () => {
    console.log(`El Reino esta corriendo en el puerto ${PORT}`);
});
