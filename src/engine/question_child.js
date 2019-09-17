const readlineSync = require('readline-sync');

const response = readlineSync.question(process.argv[2].trim() + '\r\n');

process.send(response);
