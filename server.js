// ----------------------------------------------------------------------
// Dependencies
// ----------------------------------------------------------------------
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { js2xml } from 'xml-js';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { v4 as uuidv4 } from 'uuid';

// ----------------------------------------------------------------------
// Database Setup
// ----------------------------------------------------------------------
const adapter = new JSONFile('db.json');
const defaultData = { declarations: [] };
const db = new Low(adapter, defaultData);
await db.read();

// ----------------------------------------------------------------------
// App Initialization & Middleware
// ----------------------------------------------------------------------
const app = express();
const port = 3001;
app.use(cors());
app.use(bodyParser.json());

// ----------------------------------------------------------------------
// API Endpoints for Declarations
// ----------------------------------------------------------------------

// GET all declarations
app.get('/declarations', async (req, res) => {
  try {
    await db.read();
    res.status(200).json(db.data.declarations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch declarations.' });
  }
});

// POST a new declaration
app.post('/declarations', async (req, res) => {
  try {
    await db.read();

    const newDeclaration = { ...req.body, id: uuidv4(), items: [] };
    const { importer, exporter } = newDeclaration;

    // Handle new importer
    if (!importer?.id && importer?.name && importer?.number) {
      const newImporter = { id: uuidv4(), name: importer.name, tin: importer.number };
      db.data.users.push(newImporter);
      newDeclaration.importer.id = newImporter.id;
    } else if (importer?.id && importer?.number) {
      const user = db.data.users.find(u => u.id === importer.id);
      if (user) user.tin = importer.number;
    }

    // Handle new exporter
    if (!exporter?.id && exporter?.name && exporter?.number) {
      const newExporter = { id: uuidv4(), name: exporter.name, tin: exporter.number };
      db.data.exporters.push(newExporter);
      newDeclaration.exporter.id = newExporter.id;
    } else if (exporter?.id && exporter?.number) {
      const user = db.data.exporters.find(u => u.id === exporter.id);
      if (user) user.tin = exporter.number;
    }

    db.data.declarations.push(newDeclaration);
    await db.write();

    res.status(201).json(newDeclaration);
  } catch (error) {
    console.error('Error creating declaration:', error);
    res.status(500).json({ error: 'Failed to create declaration.' });
  }
});

// PUT (update) a declaration's main details
app.put('/declarations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;

    await db.read();
    const declarationIndex = db.data.declarations.findIndex(d => d.id === id);
    if (declarationIndex === -1) {
      return res.status(404).json({ error: 'Declaration not found.' });
    }

    const { importer, exporter } = updatedData;

    // Handle new importer
    if (!importer?.id && importer?.name && importer?.number) {
      const newImporter = { id: uuidv4(), name: importer.name, tin: importer.number };
      db.data.users.push(newImporter);
      updatedData.importer.id = newImporter.id;
    } else if (importer?.id && importer?.number) {
      const user = db.data.users.find(u => u.id === importer.id);
      if (user) user.tin = importer.number;
    }

    // Handle new exporter
    if (!exporter?.id && exporter?.name && exporter?.number) {
      const newExporter = { id: uuidv4(), name: exporter.name, tin: exporter.number };
      db.data.exporters.push(newExporter);
      updatedData.exporter.id = newExporter.id;
    } else if (exporter?.id && exporter?.number) {
      const user = db.data.exporters.find(u => u.id === exporter.id);
      if (user) user.tin = exporter.number;
    }

    const existingItems = db.data.declarations[declarationIndex].items;
    db.data.declarations[declarationIndex] = { ...updatedData, id, items: existingItems };

    await db.write();
    res.status(200).json(db.data.declarations[declarationIndex]);
  } catch (error) {
    console.error('Error updating declaration:', error);
    res.status(500).json({ error: 'Failed to update declaration.' });
  }
});


// DELETE a declaration
app.delete('/declarations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.read();
    db.data.declarations = db.data.declarations.filter(d => d.id !== id);
    await db.write();
    res.status(200).json({ message: 'Declaration deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete declaration.' });
  }
});

// ----------------------------------------------------------------------
// API Endpoints for Tariffs
// ----------------------------------------------------------------------

/**
 * PUT /declarations/:id/tariffs
 * Replaces the entire list of tariffs for a given declaration.
 * This is simpler and more atomic than managing individual add/edit/delete operations.
 */
app.put('/declarations/:id/tariffs', async (req, res) => {
  try {
    const { id } = req.params;
    const { tariffs } = req.body;

    if (!tariffs || !Array.isArray(tariffs)) {
      return res.status(400).json({ error: 'Request body must contain a "tariffs" array.' });
    }

    await db.read();
    const declaration = db.data.declarations.find(d => d.id === id);
    if (!declaration) {
      return res.status(404).json({ error: 'Declaration not found.' });
    }

    // Create a map for quick lookup of incoming tariffs
    const incomingMap = new Map();
    const updatedTariffs = tariffs.map(tariff => {
      const finalId = tariff.id || uuidv4();
      incomingMap.set(finalId, true);
      return { ...tariff, id: finalId };
    });

    // Remove tariffs that are not in the incoming list
    declaration.items = (declaration.items || []).filter(t => incomingMap.has(t.id));

    // Update or insert tariffs
    updatedTariffs.forEach(updated => {
      const existingIndex = declaration.items.findIndex(t => t.id === updated.id);
      if (existingIndex !== -1) {
        declaration.items[existingIndex] = updated; // update
      } else {
        declaration.items.push(updated); // new
      }
    });

    await db.write();
    res.status(200).json(declaration);

  } catch (error) {
    console.error('Error updating tariffs:', error);
    res.status(500).json({ error: 'Failed to update tariffs.' });
  }
});


// Get all tariffs
app.get('/tariffs', async (req, res) => {
  await db.read();
  const codes = db.data.tariffs || [];
  res.json(codes);
});


// GET all users
app.get('/users', async (req, res) => {
  try {
    await db.read();
    const users = db.data.users || [];
    res.status(200).json(users);
  } catch (error) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});


// GET all exporters
app.get('/exporters', async (req, res) => {
  try {
    await db.read();
    const exporters = db.data.exporters || [];
    res.status(200).json(exporters);
  } catch (error) {
    console.error('Failed to fetch exporters:', error);
    res.status(500).json({ error: 'Failed to fetch exporters.' });
  }
});


// ----------------------------------------------------------------------
// XML Generation (reading from DB)
// ----------------------------------------------------------------------
app.post('/generate-xml', async (req, res) => {
  const masterBill = req.body; // Expecting masterBill object
  try {
    await db.read();
    const { declarations } = db.data;

    if (!declarations || declarations.length === 0) {
      return res.status(400).json({ error: 'No declarations in DB.' });
    }

    const structuredJs = structureDataForXml(declarations, masterBill);
    const xmlData = js2xml(structuredJs, { compact: true, spaces: 4 });

    res.header('Content-Type', 'application/xml');
    res.header('Content-Disposition', 'attachment; filename="SADEntry.xml"');
    res.status(200).send(xmlData);

  } catch (error) {
    console.error('XML generation error:', error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

function structureDataForXml(consolidatedItems, masterBill) {
  const mode = masterBill.consignment?.transportMode;
  const sadEntryObject = {
    _declaration: { _attributes: { version: '1.0', encoding: 'UTF-8' } },
    SADEntry: {
      Date: { _text: new Date().toISOString().split('T')[0] },
      Regime: { _text: 'IM1' },
      Importer: { Number: { _text: "20005264" } },
      Exporter: { Number: { _text: masterBill.exporter?.number || '' } },
      Finance: {},
      Consignment: {
        DepartureDate: { _text: masterBill.consignment?.departureDate || '' },
        ArrivalDate: { _text: masterBill.consignment?.arrivalDate || '' },
        ExportCountry: { _text: "USA" },
        ImportCountry: { _text: "USA" },
        ShippingPort: { _text: masterBill.consignment?.shippingPort || '' },
        DischargePort: { _text: mode == "SEA" ? 'KYGEC' : "KYGCM"},
        TransportMode: { _text: mode || '' },
      },
      Shipment: {
        VesselCode: { _text: masterBill.shipment?.vesselCode || '' },
        VoyageNo: { _text: masterBill.shipment?.voyageNo || '' },
        ShippingAgent: { _text: masterBill.shipment?.shippingAgent || '' },
        BillNumber: { _text: masterBill.shipment?.billNumber || '' },
        BillType: { _text: "CONSOLIDATED" },
      },
      Packages: {
        PkgCount: { _text: masterBill.packages?.pkgCount || '' },
        PkgType: { _text: masterBill.packages.pkgType },
        GrossWt: { _text: masterBill.packages?.grossWt || '' },
        GrossWtUnit: { _text: 'LB' },
        GrossVol: { _text: masterBill.packages?.grossVol || '' },
        GrossVolUnit: { _text: 'CF' },
        Contents: { _text: masterBill.packages?.contents || '' },
        CategoryOfGoods: { _text: "1" },
      },
    
      MoneyDeclaredFlag: { _text: "N" },
      ConsolidatedShipment: {
        ConsolidatedItem: consolidatedItems.map(item => ({
          Importer: { Number: { _text: item.importer.number } },
          Exporter: { Number: { _text: item.exporter.number } },
          Finance: {},
          BillNumber: { _text: item.billNumber },
          Packages: {
            PkgCount: { _text: item.packages.pkgCount },
            PkgType: { _text: item.packages.pkgType },
            GrossWt: { _text: item.packages.grossWt },
            GrossWtUnit: { _text: "LB" },
            GrossVol: { _text: item.packages.grossVol },
            GrossVolUnit: { _text: "CF" },
            Contents: { _text: item.packages.contents },
            CategoryOfGoods: { _text: "1" },
          },
          Valuation: {
            Currency: { _text: "USD" },
            NetCost: { _text: item.valuation.netCost },
            NetInsurance: { _text: item.valuation.netInsurance },
            NetFreight: { _text: item.valuation.netFreight },
            TermsOfDelivery: { _text: "FOB" },
          },
          Items: (item.items || []).map(tariff => ({
            Code: { _text: tariff.code },
            Desc: { _text: tariff.desc },
            Origin: { _text: "USA" },
            Qty: { _text: tariff.qty },
            QtyUnit: { _text: "LB" },
            Cost: { _text: tariff.cost },
            Insurance: { _text: tariff.insurance },
            Freight: { _text: tariff.freight },
            InvNumber: { _text: tariff.invNumber },
            Procedure: {
              Code: { _text: "HOME" },
              ImporterNumber: { _text: tariff.procedure.importerNumber },
            },
          })),
          MoneyDeclaredFlag: { _text: "N" },
        }))
      }
    }
  };
  return sadEntryObject;
}

// ----------------------------------------------------------------------
// Start the Server
// ----------------------------------------------------------------------
app.listen(port, () => {
  console.log(`Backend server is running on http://localhost:${port}`);
});
