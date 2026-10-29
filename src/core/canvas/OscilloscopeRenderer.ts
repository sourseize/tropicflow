export class OscilloscopeRenderer {
  public static render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    dataArray: Uint8Array<ArrayBuffer>,
    beamColor: string = '#70E000'
  ): void {
    ctx.fillStyle = 'rgba(12, 26, 18, 0.28)';
    ctx.fillRect(0, 0, width, height);

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(43, 83, 61, 0.35)';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.stroke();

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = beamColor;
    ctx.shadowColor = beamColor;
    ctx.shadowBlur = 10;
    ctx.beginPath();

    const sliceWidth = width / dataArray.length;
    let x = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
