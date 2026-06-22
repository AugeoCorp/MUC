import { Text } from "ink";
import type { ReactElement } from "react";

export function Title(): ReactElement {
	return (
		<Text bold color="magentaBright">
			muc · a shared text box
		</Text>
	);
}
