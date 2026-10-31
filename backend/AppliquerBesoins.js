/**
 * Met à jour la colonne nb_requis de la feuille Shifts selon le rôle, sans toucher au reste.
 * A coller dans un fichier du projet Apps Script, puis exécuter appliquerBesoins depuis l'éditeur.
 * Modifiable et relançable à tout moment.
 */
function appliquerBesoins() {
  var BESOINS = { service: 3, commande: 3, back: 2, merch: 2, general: 1, accueil: 1 };
  var s = sheet_(SHEETS.SHIFTS);
  var colonne = HEADERS.Shifts.indexOf('nb_requis') + 1;
  var modifies = 0;
  readTable_(SHEETS.SHIFTS).forEach(function (shift) {
    var besoin = BESOINS[normName_(shift.intitule)];
    if (besoin === undefined) return;
    s.getRange(shift._row, colonne).setValue(besoin);
    modifies++;
  });
  SpreadsheetApp.flush();
  console.log(modifies + ' shifts mis à jour.');
}
