// VCF parsing utility
import fs from 'fs';

// Simple VCF parser to extract phone numbers
export function parseVCF(filePath) {
  const data = fs.readFileSync(filePath, 'utf-8');
  const numbers = [];
  // Match lines like: TEL;TYPE=CELL:1234567890 or TEL:1234567890
  const regex = /^TEL.*:(.+)$/gim;
  let match;
  while ((match = regex.exec(data)) !== null) {
    // Remove non-digit characters
    const num = match[1].replace(/\D/g, '');
    if (num.length > 6) numbers.push(num);
  }
  return numbers;
}
