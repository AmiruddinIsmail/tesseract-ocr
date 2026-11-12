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

export function decodeIc(icDigits: string, pb: string, serial: string) {
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
    const century = yyNum > currentYearTwoDigit + 5 ? 1900 : 2000;
    const fullYear = century + yyNum;
    const dobDate = new Date(fullYear, mmNum - 1, ddNum);
    if (!isNaN(dobDate.getTime()) && dobDate.getDate() === ddNum) {
      dateOfBirth = `${fullYear}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
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
  return { dateOfBirth, age, gender, birthPlace: null };
}

export function parseMykadText(rawText: string): MykadData {
  const lines = rawText
    .toUpperCase()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const fullNormalizedText = lines.join(' ');

  // Strong IC number patterns
  let icNumber: string | null = null;
  const icPatterns = [
    /([0-9OIl]{6})[\s\-–—]*([0-9OIl]{2})[\s\-–—]*([0-9OIl]{4})/g,
    /([0-9OIl]{6})\s*-\s*([0-9OIl]{2})\s*-\s*([0-9OIl]{4})/g,
    /NO[:.\s]*([0-9OIl]{6})[\s\-]*([0-9OIl]{2})[\s\-]*([0-9OIl]{4})/gi,
    /(\d{6})[\s\-]?(\d{2})[\s\-]?(\d{4})/g,
  ];

  for (const pattern of icPatterns) {
    const matches = [...fullNormalizedText.matchAll(pattern)];
    for (const match of matches) {
      const cleanDigits = (str: string) => str.replace(/O/g, '0').replace(/[Il]/g, '1').replace(/[^0-9]/g, '');
      const candidate = `${cleanDigits(match[1])}-${cleanDigits(match[2])}-${cleanDigits(match[3])}`;
      if (candidate.replace(/-/g, '').length === 12) {
        icNumber = candidate;
        break;
      }
    }
    if (icNumber) break;
  }

  let dateOfBirth: string | null = null;
  let age: number | null = null;
  let gender: 'MALE' | 'FEMALE' | null = null;

  if (icNumber) {
    const parts = icNumber.split('-');
    if (parts.length === 3) {
      const decoded = decodeIc(parts[0], parts[1], parts[2]);
      dateOfBirth = decoded.dateOfBirth;
      age = decoded.age;
      gender = decoded.gender;
    }
  }

  // Minimal fields for compatibility
  return {
    icNumber,
    name: null,
    address: null,
    gender,
    dateOfBirth,
    age,
    birthPlace: null,
    isCitizen: /WARGANEGARA|WARGA\s*NEGARA/i.test(fullNormalizedText)
  };
}