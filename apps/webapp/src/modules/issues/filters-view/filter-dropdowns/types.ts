/**
 * The two faces of a value filter. The picker is what opens from the filter
 * menu; the chip shows an applied filter and reopens the same choice. Both are
 * handed the stored values and give back new ones; which operator applies is
 * decided by the filter, not by them.
 *
 * Stored values are ids, or names for status and label, or numbers for
 * priority.
 */
export type FilterValues = string[] | number[];

export interface FilterPickerProps {
  value: FilterValues;
  onChange: (value: FilterValues) => void;
  onClose: () => void;
}

export interface FilterChipProps {
  value: FilterValues;
  onChange: (value: FilterValues) => void;
  teamIdentifier?: string;
}
