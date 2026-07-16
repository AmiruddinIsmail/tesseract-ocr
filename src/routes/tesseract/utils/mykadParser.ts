export interface MykadData {
  icNumber: string | null;
  name: string | null;
  address: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  dateOfBirth: string | null;
  age: number | null;
  birthPlace: string | null;
  isCitizen: boolean;
}

function decodeIc(icDigits: string, pb: string, serial: string) {
  const yy = icDigits.slice(0, 2);
  const mm = icDigits.slice(2, 4);
  const dd = icDigits.slice(4, 6);
  let dateOfBirth: string | null = null;
  let age: number | null = null;

  const mmNum = parseInt(mm, 10);
  const ddNum = parseInt(dd, 10);

  if (mmNum >= 1 && mmNum <= 12 && ddNum >= 1 && ddNum <= 31) {
    const currentYearTwoDigit = new Date().getFullYear() % 100;
    const yyNum = parseInt(yy, 10);
    const century = yyNum > currentYearTwoDigit ? 1900 : 2000;
    const fullYear = century + yyNum;

    const dobDate = new Date(fullYear, mmNum - 1, ddNum);
    if (!isNaN(dobDate.getTime()) && dobDate.getDate() === ddNum) {
      dateOfBirth = `${fullYear}-${mm}-${dd}`;
      const today = new Date();
      let calcAge = today.getFullYear() - fullYear;
      const hasHadBirthdayThisYear =
        today.getMonth() > mmNum - 1 ||
        (today.getMonth() === mmNum - 1 && today.getDate() >= ddNum);
      if (!hasHadBirthdayThisYear) calcAge--;
      age = calcAge;
    }
  }

  const lastDigit = parseInt(serial.slice(-1), 10);
  const gender: 'MALE' | 'FEMALE' = lastDigit % 2 === 0 ? 'FEMALE' : 'MALE';
  const birthPlace = null;

  return { dateOfBirth, age, gender, birthPlace };
}

export function parseMykadText(rawText: string): MykadData {
  let text = rawText
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .trim();

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // IC Number
  const icMatch = text.match(/(\d{6})[\s\-–—]*(\d{2})[\s\-–—]*(\d{4})/);
  const icNumber = icMatch ? `${icMatch[1]}-${icMatch[2]}-${icMatch[3]}` : null;

  let dateOfBirth: string | null = null;
  let age: number | null = null;
  let gender: 'MALE' | 'FEMALE' | null = null;
  let birthPlace: string | null = null;

  if (icMatch) {
    const decoded = decodeIc(icMatch[1], icMatch[2], icMatch[3]);
    dateOfBirth = decoded.dateOfBirth;
    age = decoded.age;
    gender = decoded.gender;
    birthPlace = decoded.birthPlace;
  }

  // ==================== GENERAL NAME DETECTION ====================
  const commonIgnore = new Set([
    'MYKAD', 'KAD', 'PENGENALAN', 'MALAYSIA', 'WARGANEGARA', 'IDENTITY',
    'CARD', 'ISLAM', 'LELAKI', 'PEREMPUAN', 'MK', 'CN', 'XX', 'X', 'H',
    '=', '_', '~', '|', 'C', 'MY', 'GDW', 'KAMPUNG', 'BAYANGAN', 
    'KENINGAU', 'SABAH', 'WARGA', 'NEGARA'
  ]);

  let name: string | null = null;

  // Strategy 1: Find longest sequence of words that looks like a name
  for (const line of lines) {
    const words = line.split(/\s+/).filter(w => w.length > 1);
    const cleanWords = words.filter(word => !commonIgnore.has(word));

    if (cleanWords.length >= 2) {
      // Prefer sequences with at least 2 longer words (typical for names)
      const longWords = cleanWords.filter(w => w.length > 3);
      if (longWords.length >= 2) {
        name = cleanWords.join(' ');
        break;
      }
    }
  }

  // Strategy 2: Regex for typical name pattern (2 or more capitalized words)
  if (!name) {
    const nameMatch = text.match(/\b([A-Z]{3,}\s+){1,}[A-Z]{3,}\b/);
    if (nameMatch) {
      let candidate = nameMatch[0];
      // Remove any trailing address-like words
      candidate = candidate.replace(/\s+(GDW|KAMPUNG|JALAN|NO|LOT|\d).*$/i, '');
      name = candidate.trim();
    }
  }

  // Strategy 3: Fallback - longest uppercase text without numbers
  if (!name) {
    const nameCandidate = lines.find(line =>
      line.length > 12 &&
      /^[A-Z\s]+$/.test(line) &&
      !/\d/.test(line)
    );
    if (nameCandidate) {
      name = nameCandidate
        .split(' ')
        .filter(w => !commonIgnore.has(w) && w.length > 1)
        .join(' ');
    }
  }

  // Address
  let address: string | null = null;
  const postcodeIndex = lines.findIndex((l) => /\b\d{5}\b/.test(l));
  if (postcodeIndex !== -1) {
    const start = Math.max(0, postcodeIndex - 2);
    address = lines.slice(start, postcodeIndex + 3).join(', ');
  }

  const isCitizen = /WARGANEGARA|WARGA\s*NEGARA/.test(text);

  return {
    icNumber,
    name,
    address,
    gender,
    dateOfBirth,
    age,
    birthPlace,
    isCitizen
  };
}