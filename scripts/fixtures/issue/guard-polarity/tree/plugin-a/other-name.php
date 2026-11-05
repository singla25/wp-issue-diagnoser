<?php
if ( function_exists( 'other' ) ) {
	mysql_close();
}
if ( ! function_exists( 'other' ) ) {
	$x = 1;
} else {
	mysql_close();
}
