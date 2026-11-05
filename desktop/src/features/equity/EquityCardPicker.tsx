import { RANKS } from "../../domain/types";

const SUITS = ["c", "d", "h", "s"] as const;

type Props = {
  used: Set<string>;
  onPick: (card: string) => void;
  onClose: () => void;
};

export function EquityCardPicker({ used, onPick, onClose }: Props) {
  return (
    <div className="equity-card-picker" role="dialog" aria-label="Card picker">
      <div className="equity-card-picker-head">
        <strong>Pick card</strong>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="equity-card-picker-grid">
        {SUITS.map((suit) => (
          <div key={suit} className="equity-card-picker-suit">
            {RANKS.map((rank) => {
              const card = `${rank}${suit}`;
              const disabled = used.has(card);
              return (
                <button
                  key={card}
                  type="button"
                  className={`equity-card-btn suit-${suit}`}
                  disabled={disabled}
                  onClick={() => {
                    if (!disabled) {
                      onPick(card);
                    }
                  }}
                >
                  {card}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
