export class SpectrumRenderer {
  public static render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frequencyData: Uint8Array<ArrayBuffer>
  ): void {
    ctx.fillStyle = 'rgba(12, 26, 18, 0.4)';
    ctx.fillRect(0, 0, width, height);

    const bands = 48;
    const barWidth = (width / bands) - 2;
    const step = Math.floor(frequencyData.length / (bands * 1.6));

    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, '#70E000');
    gradient.addColorStop(0.55, '#FF9E00');
    gradient.addColorStop(0.85, '#FF6B35');
    gradient.addColorStop(1, '#FF382E');

    for (let i = 0; i < bands; i++) {
      const dataIndex = Math.min(frequencyData.length - 1, i * step);
      const value = frequencyData[dataIndex] / 255.0;
      const barHeight = Math.max(3, value * height * 0.95);
      const x = i * (barWidth + 2);
      const y = height - barHeight;

      ctx.fillStyle = gradient;
      ctx.shadowColor = value > 0.7 ? '#FF382E' : '#FF9E00';
      ctx.shadowBlur = value > 0.6 ? 8 : 0;

      ctx.fillRect(x, y, barWidth, barHeight);

      if (barHeight > 10) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(x, y, barWidth, 2);
      }
    }
    ctx.shadowBlur = 0;
  }
}
