import type { ReactNode } from 'react';

export function DataTable({ label, columns, rows }: {
  label: string;
  columns: readonly string[];
  rows: readonly { id: string; cells: readonly ReactNode[] }[];
}) {
  return <div className="ui-data-table-scroll">
    <table className="ui-data-table ui-text-small" aria-label={label}>
      <thead><tr>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
      <tbody>{rows.map(({ id, cells }) => <tr key={id}>
        {cells.map((cell, index) => index === 0
          ? <th key={index} scope="row">{cell}</th>
          : <td key={index}>{cell}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}
