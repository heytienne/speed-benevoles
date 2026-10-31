/**
 * Recopie les besoins de la feuille PolesRoles dans la colonne nb_requis de la feuille Shifts.
 * A coller dans un fichier du projet Apps Script, puis exécuter appliquerBesoins depuis l'éditeur.
 * Relançable après chaque modification de PolesRoles.
 */
function appliquerBesoins() {
  var besoins = {};
  readTable_(SHEETS.ROLES).forEach(function (r) {
    besoins[wishKey_(r.pole, r.role)] = Number(r.besoin) || 0;
  });
  var s = sheet_(SHEETS.SHIFTS);
  var colonne = HEADERS.Shifts.indexOf('nb_requis') + 1;
  var modifies = 0;
  readTable_(SHEETS.SHIFTS).forEach(function (shift) {
    var besoin = besoins[wishKey_(shift.pole, shift.intitule)];
    if (besoin === undefined) return;
    s.getRange(shift._row, colonne).setValue(besoin);
    modifies++;
  });
  SpreadsheetApp.flush();
  console.log(modifies + ' shifts mis à jour.');
}
