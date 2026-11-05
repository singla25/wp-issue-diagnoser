<?php
if ( ! function_exists( 'eregi' ) ) {
	$x = 1;
} elseif ( $ok ) {
	eregi( 'a', 'b' );
}
if ( $ok ) {
	$x = 1;
} elseif ( function_exists( 'eregi' ) ) {
	eregi( 'a', 'b' );
}
if ( ! function_exists( 'eregi' ) ) {
	$x = 1;
} elseif ( $ok ) {
	$x = 2;
} else {
	eregi( 'a', 'b' );
}
if ( ! function_exists( 'eregi' ) ) {
	$x = 1;
} else if ( $ok ) {
	eregi( 'a', 'b' );
}
