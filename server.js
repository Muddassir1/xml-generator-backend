// ----------------------------------------------------------------------
// Dependencies
// ----------------------------------------------------------------------
import multer from 'multer';
import { parse } from 'csv-parse';
import fs from 'fs';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { js2xml } from 'xml-js';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { v4 as uuidv4 } from 'uuid';

/**
 * Allocate a monetary total (dollars) proportionally across weights (e.g. tariff costs)
 * using integer cents and the largest-remainder method so allocations sum exactly to total.
 * Returns an array of strings formatted to two decimals (e.g. "12.34").
 */
function allocateProportionalToCents(totalAmount, weights) {
  const totalCents = Math.round(Number(totalAmount) * 100);
  const weightNums = weights.map(w => Number(w) || 0);
  const weightSum = weightNums.reduce((s, v) => s + v, 0);

  if (totalCents === 0 || weightSum === 0) {
    // Return zero for each weight if nothing to distribute or no weights
    return weights.map(() => (0).toFixed(2));
  }

  // compute exact shares in cents (may be fractional), floor them, record fractions
  const exactShares = weightNums.map(w => (w / weightSum) * totalCents);
  const floorShares = exactShares.map(s => Math.floor(s));
  const fractions = exactShares.map((s, i) => ({ i, frac: s - floorShares[i] }));

  // Distribute remaining cents by largest fractional remainders
  let assigned = floorShares.reduce((a, b) => a + b, 0);
  let remainder = totalCents - assigned;
  fractions.sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) {
    floorShares[fractions[k].i] += 1;
  }

  return floorShares.map(c => (c / 100).toFixed(2));
}

/**
 * Divide a monetary total equally across items using integer cents and largest-remainder method.
 * Returns an array of strings formatted to two decimals (e.g. "12.34").
 */
function divideEquallyInCents(totalAmount, count) {
  if (count === 0) return [];
  
  const totalCents = Math.round(Number(totalAmount) * 100);
  const perItem = Math.floor(totalCents / count);
  const remainder = totalCents % count;
  
  const shares = Array(count).fill(perItem);
  // Distribute remaining cents to first items
  for (let i = 0; i < remainder; i++) {
    shares[i] += 1;
  }
  
  return shares.map(c => (c / 100).toFixed(2));
}

// ----------------------------------------------------------------------
// Database Setup
// ----------------------------------------------------------------------
const adapter = new JSONFile('db.json');
const defaultData = { declarations: [], exporters: [] };
const db = new Low(adapter, defaultData);
await db.read();

const usersAdapter = new JSONFile('users.json');
const usersDefaultData = { users: [] };
const usersDb = new Low(usersAdapter, usersDefaultData);
await usersDb.read();

// ----------------------------------------------------------------------
// App Initialization & Middleware
// ----------------------------------------------------------------------
const app = express();
const port = 3001;
app.use(cors());
app.use(bodyParser.json());

// Set up multer for file upload
const upload = multer({ dest: 'uploads/' });

// ----------------------------------------------------------------------
// API Endpoints for Declarations
// ----------------------------------------------------------------------

// GET all declarations
app.get('/declarations', async (req, res) => {
  try {
    await db.read();
    const { transportMode } = req.query;

    let filteredDeclarations = db.data.declarations;
    if (transportMode) {
      filteredDeclarations = db.data.declarations.filter(declaration =>
        declaration.transportMode === transportMode
      );
    }

    res.status(200).json(filteredDeclarations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch declarations.' });
  }
});

app.post('/declarations', async (req, res) => {
  try {
    await db.read();
    await usersDb.read();

    const { tariffs, ...declarationData } = req.body;
    const newDeclaration = { ...declarationData, id: uuidv4(), items: [] };
    const { importer, exporter } = newDeclaration;

    // Handle importer - check by TIN number
    let importerId;
    if (importer?.id) {
      // Existing importer - find by ID and update TIN
      const existingUser = usersDb.data.users.find(u => u.id === importer.id);
      if (existingUser) {
        // Update TIN number (always, since it's provided in request)
        existingUser.tin = importer.number;
        await usersDb.write();
        importerId = existingUser.id;
        newDeclaration.importer.id = importerId;
      }
    } else {
      // New importer - create new user
      const newImporter = {
        id: uuidv4(),
        name: importer.name || '',
        tin: importer.number
      };
      usersDb.data.users.push(newImporter);
      importerId = newImporter.id;
      newDeclaration.importer.id = importerId;
      await usersDb.write();
    }

    // Handle exporter - associate with importer (supports with/without TIN)
    if (importerId && exporter) {
      // If exporter has TIN, try to reuse by (tin + importerId)
      if (exporter.number) {
        const existingByTin = db.data.exporters.find(e => e.tin === exporter.number && e.uid === importerId);
        if (existingByTin) {
          // Optionally update basic fields
          existingByTin.name = exporter.name || existingByTin.name || '';
          existingByTin.address = exporter.address || existingByTin.address || '';
          existingByTin.city = exporter.city || existingByTin.city || '';
          existingByTin.state = exporter.state || existingByTin.state || '';
          existingByTin.postalcode = exporter.postalcode || existingByTin.postalcode || '';
          existingByTin.country = exporter.country || existingByTin.country || '';
          existingByTin.phone = exporter.phone || existingByTin.phone || '';
          await db.write();
          newDeclaration.exporter.id = existingByTin.id;
        } else {
          const newExporter = {
            id: uuidv4(),
            name: exporter.name || '',
            tin: exporter.number || '',
            address: exporter.address || '',
            city: exporter.city || '',
            state: exporter.state || '',
            postalcode: exporter.postalcode || '',
            country: exporter.country || '',
            phone: exporter.phone || '',
            uid: importerId
          };
          db.data.exporters.push(newExporter);
          newDeclaration.exporter.id = newExporter.id;
        }
      } else {
        // No TIN path: always create a new exporter record linked to the importer
        const newExporter = {
          id: uuidv4(),
          name: exporter.name || '',
          tin: '',
          address: exporter.address || '',
          city: exporter.city || '',
          state: exporter.state || '',
          postalcode: exporter.postalcode || '',
          country: exporter.country || '',
          phone: exporter.phone || '',
          uid: importerId
        };
        db.data.exporters.push(newExporter);
        newDeclaration.exporter.id = newExporter.id;
      }
    }

    // Process tariffs if provided
    if (tariffs && Array.isArray(tariffs) && tariffs.length > 0) {
      // Check if valuation data exists for tariff calculations
      const netFreight = parseFloat(newDeclaration.valuation?.netFreight || 0);
      const netCost = parseFloat(newDeclaration.valuation?.netCost || 0);
      const netInsurance = parseFloat(newDeclaration.valuation?.netInsurance || 0);

      if (netCost > 0) {
        // Build cost array for proportional allocation
        const costNums = tariffs.map(t => parseFloat(t.cost || 0));
        const freightAlloc = allocateProportionalToCents(netFreight, costNums);
        const insuranceAlloc = allocateProportionalToCents(netInsurance, costNums);

        const processedTariffs = tariffs.map((tariff, idx) => ({
          ...tariff,
          id: tariff.id || uuidv4(),
          freight: freightAlloc[idx],
          insurance: insuranceAlloc[idx]
        }));

        newDeclaration.items = processedTariffs;
      } else {
        // If netCost is 0, divide freight and insurance equally among tariffs
        const freightAlloc = divideEquallyInCents(netFreight, tariffs.length);
        const insuranceAlloc = divideEquallyInCents(netInsurance, tariffs.length);

        const processedTariffs = tariffs.map((tariff, idx) => ({
          ...tariff,
          id: tariff.id || uuidv4(),
          freight: freightAlloc[idx],
          insurance: insuranceAlloc[idx]
        }));
        newDeclaration.items = processedTariffs;
      }
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
    await usersDb.read();

    const declarationIndex = db.data.declarations.findIndex(d => d.id === id);
    if (declarationIndex === -1) {
      return res.status(404).json({ error: 'Declaration not found.' });
    }

    const { importer, exporter } = updatedData;

    // Handle importer logic
    let importerId;
    if (importer?.id) {
      // Existing importer - find by ID and update TIN
      const existingUser = usersDb.data.users.find(u => u.id === importer.id);
      if (existingUser) {
        // Update TIN number (always, since it's provided in request)
        existingUser.tin = importer.number;
        await usersDb.write();
        importerId = existingUser.id;
        updatedData.importer.id = importerId;
      }
    } else {
      // New importer - create new user
      const newImporter = {
        id: uuidv4(),
        name: importer.name || '',
        tin: importer.number
      };
      usersDb.data.users.push(newImporter);
      importerId = newImporter.id;
      updatedData.importer.id = importerId;
      await usersDb.write();
    }

    // Handle exporter - check by ID, associate with importer if provided (supports without TIN)
    if (exporter?.id || exporter?.name) {
      let exporterId;

      if (exporter.id) {
        const existingExporter = db.data.exporters.find(e => e.id === exporter.id);
        if (existingExporter) {
          // Update association with importer if not already set
          if (!existingExporter.uid && importerId) {
            existingExporter.uid = importerId;
          }
          // Update fields
          if (typeof exporter.name === 'string') existingExporter.name = exporter.name;
          if (typeof exporter.number === 'string') existingExporter.tin = exporter.number;
          if (typeof exporter.address === 'string') existingExporter.address = exporter.address;
          if (typeof exporter.city === 'string') existingExporter.city = exporter.city;
          if (typeof exporter.state === 'string') existingExporter.state = exporter.state;
          if (typeof exporter.postalcode === 'string') existingExporter.postalcode = exporter.postalcode;
          if (typeof exporter.country === 'string') existingExporter.country = exporter.country;
          if (typeof exporter.phone === 'string') existingExporter.phone = exporter.phone;
          exporterId = existingExporter.id;
        } else {
          // Create new exporter with the provided ID
          const newExporter = {
            id: exporter.id,
            name: exporter.name || '',
            tin: exporter.number || '',
            address: exporter.address || '',
            city: exporter.city || '',
            state: exporter.state || '',
            postalcode: exporter.postalcode || '',
            country: exporter.country || '',
            phone: exporter.phone || '',
            uid: importerId || null
          };
          db.data.exporters.push(newExporter);
          exporterId = newExporter.id;
        }
      } else {
        // Create new exporter with generated ID
        const newExporter = {
          id: uuidv4(),
          name: exporter.name || '',
          tin: exporter.number || '',
          address: exporter.address || '',
          city: exporter.city || '',
          state: exporter.state || '',
          postalcode: exporter.postalcode || '',
          country: exporter.country || '',
          phone: exporter.phone || '',
          uid: importerId || null
        };
        db.data.exporters.push(newExporter);
        exporterId = newExporter.id;
      }

      updatedData.exporter.id = exporterId;
    }

    const existingItems = db.data.declarations[declarationIndex].items || [];

    // Determine which tariffs/items to process: prefer updatedData.items (if provided),
    // otherwise operate on the existing items. This allows recalculation when valuation
    // changes even if the items themselves weren't replaced in the request.
    const incomingTariffs = Array.isArray(updatedData.items) ? updatedData.items : existingItems;

    // Use valuation from the update if present, otherwise fall back to existing declaration valuation
    const declarationValuation = updatedData.valuation || db.data.declarations[declarationIndex].valuation || {};
    const netFreight = parseFloat(declarationValuation.netFreight || 0);
    const netCost = parseFloat(declarationValuation.netCost || 0);
    const netInsurance = parseFloat(declarationValuation.netInsurance || 0);

    let processedTariffs = [];
    if (Array.isArray(incomingTariffs) && incomingTariffs.length > 0) {
      if (netCost > 0) {
        const costNums = incomingTariffs.map(t => parseFloat(t.cost || 0));
        const freightAlloc = allocateProportionalToCents(netFreight, costNums);
        const insuranceAlloc = allocateProportionalToCents(netInsurance, costNums);

        processedTariffs = incomingTariffs.map((tariff, idx) => ({
          ...tariff,
          id: tariff.id || uuidv4(),
          freight: freightAlloc[idx],
          insurance: insuranceAlloc[idx]
        }));
      } else {
        // If netCost is 0, divide freight and insurance equally among tariffs
        const freightAlloc = divideEquallyInCents(netFreight, incomingTariffs.length);
        const insuranceAlloc = divideEquallyInCents(netInsurance, incomingTariffs.length);

        processedTariffs = incomingTariffs.map((tariff, idx) => ({
          ...tariff,
          id: tariff.id || uuidv4(),
          freight: freightAlloc[idx],
          insurance: insuranceAlloc[idx]
        }));
      }
    } else {
      // No tariffs at all: keep existing items as-is
      processedTariffs = existingItems;
    }

    // Persist the updated declaration with recalculated items
    db.data.declarations[declarationIndex] = { ...updatedData, id, items: processedTariffs };

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

// DELETE multiple declarations (bulk delete)
app.delete('/declarations', async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of declaration IDs to delete.' });
    }

    await db.read();
    const initialCount = db.data.declarations.length;

    // Filter out the declarations with the provided IDs
    db.data.declarations = db.data.declarations.filter(d => !ids.includes(d.id));

    const deletedCount = initialCount - db.data.declarations.length;
    await db.write();

    res.status(200).json({
      message: `Successfully deleted ${deletedCount} declaration${deletedCount > 1 ? 's' : ''}.`,
      deletedCount
    });
  } catch (error) {
    console.error('Error deleting declarations:', error);
    res.status(500).json({ error: 'Failed to delete declarations.' });
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


    const netFreight = parseFloat(declaration.valuation.netFreight || 0);
    const netCost = parseFloat(declaration.valuation.netCost || 0);
    const netInsurance = parseFloat(declaration.valuation.netInsurance || 0);

    // Create a map for quick lookup of incoming tariffs
    const incomingMap = new Map();

    let updatedTariffs;
    if (netCost > 0) {
      const costNums = tariffs.map(t => parseFloat(t.cost || 0));
      const freightAlloc = allocateProportionalToCents(netFreight, costNums);
      const insuranceAlloc = allocateProportionalToCents(netInsurance, costNums);

      updatedTariffs = tariffs.map((tariff, idx) => {
        const finalId = tariff.id || uuidv4();
        incomingMap.set(finalId, true);
        return { ...tariff, id: finalId, freight: freightAlloc[idx], insurance: insuranceAlloc[idx] };
      });
    } else {
      // If netCost is 0, divide freight and insurance equally among tariffs
      const freightAlloc = divideEquallyInCents(netFreight, tariffs.length);
      const insuranceAlloc = divideEquallyInCents(netInsurance, tariffs.length);

      updatedTariffs = tariffs.map((tariff, idx) => {
        const finalId = tariff.id || uuidv4();
        incomingMap.set(finalId, true);
        return { ...tariff, id: finalId, freight: freightAlloc[idx], insurance: insuranceAlloc[idx] };
      });
    }

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
    await usersDb.read();
    const users = usersDb.data.users || [];
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

// GET exporters for a specific importer
app.get('/exporters/by-importer/:importerId', async (req, res) => {
  try {
    const { importerId } = req.params;
    await db.read();
    const exporters = db.data.exporters.filter(e => e.uid === importerId) || [];
    res.status(200).json(exporters);
  } catch (error) {
    console.error('Failed to fetch exporters:', error);
    res.status(500).json({ error: 'Failed to fetch exporters.' });
  }
});

app.get('/master-bill', async (req, res) => {
  try {
    await db.read();

    // Check if master bill exists in database
    if (!db.data.masterBill) {
      return res.status(404).json({
        error: 'No master bill found in database.',
        masterBill: null
      });
    }

    // Return the master bill data
    res.status(200).json(db.data.masterBill);

  } catch (error) {
    console.error('Error fetching master bill:', error);
    res.status(500).json({
      error: 'An internal server error occurred while fetching master bill.'
    });
  }
});

// ----------------------------------------------------------------------
// XML Generation (reading from DB)
// ----------------------------------------------------------------------
app.post('/generate-xml', async (req, res) => {
  // Accept either `{ masterBill: {...}, selectedIds: [...] }` or legacy raw masterBill body
  const requestBody = req.body || {};
  const masterBill = requestBody.masterBill || requestBody;
  const selectedIds = Array.isArray(requestBody.selectedIds)
    ? requestBody.selectedIds
    : (Array.isArray(requestBody.ids) ? requestBody.ids : []);

  try {
    await db.read();
    const allDeclarations = db.data.declarations || [];

    // If selectedIds provided, filter the declarations to only those IDs
    let declarationsToUse = allDeclarations;
    if (selectedIds && selectedIds.length > 0) {
      declarationsToUse = allDeclarations.filter(d => selectedIds.includes(d.id));
      if (!declarationsToUse || declarationsToUse.length === 0) {
        return res.status(400).json({ error: 'No declarations match the selected IDs.' });
      }
    }

    if (!declarationsToUse || declarationsToUse.length === 0) {
      return res.status(400).json({ error: 'No declarations in DB.' });
    }

    // Save master bill data to database (single object, not array)
    const masterBillEntry = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...masterBill
    };

    // Save the master bill as a single object
    db.data.masterBill = masterBillEntry;

    // Write changes to the database
    await db.write();

    const structuredJs = structureDataForXml(declarationsToUse, masterBill);
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
      Importer: { Number: { _text: "20738450" } },
      // Exporter: { Number: { _text: masterBill.exporter?.number || '' } },
      Exporter: {
        Name: { _text: "Novotrans" },
        Address: { _text: "6371 NW 102nd Ave" },
        City: { _text: "Doral" },
        State: { _text: "FL" },
        PostalCode: { _text: "33178" },
        Country: { _text: "USA" },
      },
      Finance: {},
      Consignment: {
        DepartureDate: { _text: masterBill.consignment?.departureDate || '' },
        ArrivalDate: { _text: masterBill.consignment?.arrivalDate || '' },
        ExportCountry: { _text: "USA" },
        ImportCountry: { _text: "USA" },
        ShippingPort: { _text: masterBill.consignment?.shippingPort || '' },
        DischargePort: { _text: mode == "SEA" ? 'KYGEC' : "KYGCM" },
        TransportMode: { _text: mode || '' },
      },
      Shipment: {
        VesselCode: { _text: masterBill.shipment?.vesselCode || '' },
        VoyageNo: { _text: masterBill.shipment?.voyageNo || '' },
        ShippingAgent: { _text: masterBill.shipment?.shippingAgent || '' },
        BillNumber: { _text: masterBill.shipment?.billNumber || '' },
        BillType: { _text: "CONSOLIDATED" },
      },
      // Container section moved here - before Packages
      Container: [],
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
          Exporter: item.exporter?.number
            ? { Number: { _text: item.exporter.number } }
            : {
              Name: { _text: item.exporter?.name || '' },
              Address: { _text: item.exporter?.address || '' },
              City: { _text: item.exporter?.city || '' },
              State: { _text: item.exporter?.state || '' },
              PostalCode: { _text: item.exporter?.postalcode || '' },
              Country: { _text: item.exporter?.country || '' },
              Phone: { _text: item.exporter?.phone || '' }
            },
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
          Items: (item.items || []).map(tariff => {
            // try to find tariff definition in DB by code and use its unit if present
            const tariffDefs = (db.data.tariffs || []);
            const tariffDef = tariffDefs.find(td => String(td.code) === String(tariff.code));
            const qtyUnit = tariffDef?.unit || tariffDef?.qtyUnit || tariffDef?.QtyUnit || tariff.qtyUnit || 'LB';
            return ({
              Code: { _text: tariff.code },
              Desc: { _text: tariff.desc },
              Origin: { _text: "USA" },
              Qty: { _text: tariff.qty },
              QtyUnit: { _text: qtyUnit },
              Cost: { _text: tariff.cost },
              Insurance: { _text: tariff.insurance },
              Freight: { _text: tariff.freight },
              InvNumber: { _text: tariff.invNumber },
              Procedure: {
                Code: { _text: tariff.procedureCode },
                ImporterNumber: { _text: item.importer.number },
              },
            });
          }),
          MoneyDeclaredFlag: { _text: "N" },
        }))
      }
    }
  };

  // Populate Container array
  if (masterBill.containers && masterBill.containers.length > 0) {
    masterBill.containers.forEach(container => {
      const containerObject = {
        ContainerNumber: { _text: container.containerNumber || '' },
        ContainerType: { _text: container.containerType || '' },
        SealNumber: { _text: container.sealNumber || '' },
        DockReceipt: { _text: container.dockReceipt || '' },
        MarksAndNumbers: { _text: container.marksNumbers || '' },
        CubicSize: { _text: container.volume || '' },
        CubicUnit: { _text: 'CF' },
        GrossWt: { _text: container.weight || '' },
        GrossWtUnit: { _text: 'LB' },
      }
      sadEntryObject.SADEntry.Container.push(containerObject);
    });
  }

  return sadEntryObject;
}

// ----------------------------------------------------------------------
// CSV Upload Endpoint
// ----------------------------------------------------------------------
app.post('/declarations/upload-csv', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const transportMode = req.body.transportMode;
  if (!transportMode || !['AIR', 'OCEAN'].includes(transportMode)) {
    return res.status(400).json({ error: 'Invalid transport mode' });
  }

  try {
    const fileContent = fs.readFileSync(req.file.path);
    const records = [];

    // Parse CSV file
    await new Promise((resolve, reject) => {
      parse(fileContent, {
        columns: true,
        trim: true,
        skip_empty_lines: true,
      })
        .on('data', (data) => records.push(data))
        .on('end', resolve)
        .on('error', reject);
    });

    // Process each record
    await db.read();
    let createdCount = 0;

    for (const record of records) {
      const declaration = {
        id: uuidv4(),
        transportMode,
        billNumber: record.billNumber,
        items: [],
        importer: {
          number: record.importerNumber,
          name: record.importerName || '',
        },
        exporter: {
          number: record.exporterNumber || '',
          name: record.exporterName || '',
          address: record.exporterAddress || '',
          city: record.exporterCity || '',
          state: record.exporterState || '',
          postalcode: record.exporterPostalCode || '',
          country: record.exporterCountry || '',
          phone: record.exporterPhone || '',
        },
        packages: {
          pkgCount: record.packageCount || '',
          pkgType: record.packageType || '',
          grossWt: record.grossWeight || '',
          grossVol: record.grossVolume || '',
          contents: record.contents || '',
        },
        valuation: {
          netCost: record.netCost || '0.00',
          netFreight: record.netFreight || '0.00',
          netInsurance: record.netInsurance || '0.00',
        }
      };

      db.data.declarations.push(declaration);
      createdCount++;
    }

    await db.write();

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.status(200).json({
      message: `Successfully created ${createdCount} declarations`,
      createdCount
    });

  } catch (error) {
    console.error('Error processing CSV:', error);
    // Clean up uploaded file in case of error
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to process CSV file' });
  }
});

// ----------------------------------------------------------------------
// Start the Server
// ----------------------------------------------------------------------
app.listen(port, () => {
  console.log(`Backend server is running on http://localhost:${port}`);
});