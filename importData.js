import fs from 'fs';

// Load the JSON data
const inputFile = 'airlines.json';
const outputFile = 'airlines-deduped.json';

const airlines = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));

// Remove duplicate flights based on route
const deduped = airlines.map((airline) => {
  const seenRoutes = new Set();
  const uniqueFlights = airline.flights.filter((flight) => {
    if (seenRoutes.has(flight.route)) return false;
    seenRoutes.add(flight.route);
    return true;
  });

  return { ...airline, flights: uniqueFlights };
});

// Write the cleaned data to a new file
fs.writeFileSync(outputFile, JSON.stringify(deduped, null, 2));

console.log('Duplicates removed and saved to', outputFile);
