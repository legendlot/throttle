export function printWindow(htmlContent) {
  const w = window.open('', '_blank', 'width=800,height=600');
  if (!w) return null;
  w.document.write(htmlContent);
  w.document.close();
  w.focus();
  w.print();
  return w;
}
