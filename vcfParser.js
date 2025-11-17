// VCF parsing utility
import fs from 'fs';
import vcf from 'vcf';

export function parseVCF(filePath) {
  const data = fs.readFileSync(filePath, 'utf-8');
  const contacts = vcf.parse(data);
  const numbers = [];
  for (const contact of contacts) {
    if (contact.get('tel')) {
      const tel = contact.get('tel');
      if (Array.isArray(tel)) {
        tel.forEach(t => numbers.push(t.value.replace(/\D/g, '')));
      } else {
        numbers.push(tel.value.replace(/\D/g, ''));
      }
    }
  }
  return numbers;
}
