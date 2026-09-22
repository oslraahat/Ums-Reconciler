"use strict";
/* random unique student nicknames for the admission blast — no human types anything */

const NAMES = [
  "Rahim", "Karim", "Faruk", "Hasan", "Hussain", "Mahmud", "Jahid", "Rakib", "Sabbir",
  "Tarek", "Imran", "Rubel", "Arif", "Shakil", "Rafiq", "Monir", "Sumon", "Milon",
  "Ratan", "Jewel", "Sohel", "Babul", "Limon", "Ruhul", "Mostak", "Habib", "Noman",
  "Iqbal", "Rashed", "Belal", "Aziz", "Anwar", "Jashim", "Masud", "Sajib", "Tanvir"
];
let _nameSeq = 0;
function uniqueName() {
  const p = function (a) { return a[Math.floor(Math.random() * a.length)]; };
  /* a short base36 tail keeps it unique even across a 1000-run blast */
  _nameSeq++;
  return p(NAMES) + p(NAMES) + (Date.now().toString(36) + _nameSeq).slice(-4);
}

module.exports = { NAMES: NAMES, uniqueName: uniqueName };
