export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <img
      src="/askmed-logo.png"
      alt="AskMed"
      width={size}
      height={size}
      className="brand-logo-img"
      draggable={false}
    />
  );
}
