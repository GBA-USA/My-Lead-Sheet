import qrcode from "qrcode-generator";

export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < count; row++) {
    const rowData: boolean[] = [];
    for (let col = 0; col < count; col++) {
      rowData.push(qr.isDark(row, col));
    }
    matrix.push(rowData);
  }
  return matrix;
}

export function qrSvg(text: string, cell = 4, margin = 4): string {
  const matrix = qrMatrix(text);
  const count = matrix.length;
  const size = (count + 2 * margin) * cell;
  const viewBox = `0 0 ${size} ${size}`;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${size}" height="${size}">`;
  svg += `<rect width="${size}" height="${size}" fill="white"/>`;

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (matrix[row][col]) {
        const x = (col + margin) * cell;
        const y = (row + margin) * cell;
        svg += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="black"/>`;
      }
    }
  }

  svg += "</svg>";
  return svg;
}
